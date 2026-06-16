/**
 * Unit tests for AgentsService.
 *
 * The service owns application policy only — SSM env extraction/restoration,
 * scenario-id stamping, the shared-agent cursor + name filter, and share/clone
 * rules. Persistence is an injected AgentsRepository, so these tests use an
 * in-memory fake repo and assert on the orchestration, not on DynamoDB command
 * shapes (those are covered by the repository's own item/integration tests).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('uuid', () => ({
  v7: jest.fn(() => 'test-uuid-1234'),
}));

// Stub config so importing the service (and its repository factory) does not
// run the real env validation in config/index.ts, which calls process.exit(1)
// when the CI environment has no .env. The service injects its repo, so these
// values only satisfy the module-load-time imports.
jest.mock('../../config/index', () => ({
  config: {
    AWS_REGION: 'us-east-1',
    SSM_PARAMETER_PREFIX: '/test/mcp-env',
    AGENTS_TABLE_NAME: 'test-agents',
  },
}));

import { AgentsService } from '../agents-service.js';
import { AgentNotFoundError, type Agent } from '../../types/index.js';
import type { AgentsRepository, UpdateAgentPatch, SharedAgentsPage } from '../../repositories/agents/index.js';
import type { SsmEnvStore } from '../ssm-env-store.js';
import type { UserId, AgentId } from '@moca/core';

const USER_ID = 'user-123' as UserId;
const AGENT_ID = 'agent-456' as AgentId;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    userId: USER_ID,
    agentId: AGENT_ID,
    name: 'Test Agent',
    description: 'A test agent',
    systemPrompt: 'You are helpful',
    enabledTools: [],
    scenarios: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    isShared: false,
    createdBy: 'testuser',
    ...overrides,
  };
}

/** In-memory AgentsRepository fake; each method is a jest.fn so calls can be asserted. */
function makeFakeRepo(): jest.Mocked<AgentsRepository> {
  return {
    listByUser: jest.fn(async () => []),
    get: jest.fn(async () => null),
    put: jest.fn(async () => {}),
    update: jest.fn(async () => makeAgent()),
    toggleShare: jest.fn(async () => makeAgent({ isShared: true })),
    delete: jest.fn(async () => {}),
    listShared: jest.fn(async (): Promise<SharedAgentsPage> => ({ agents: [] })),
  } as unknown as jest.Mocked<AgentsRepository>;
}

/** SsmEnvStore fake — no real SSM. */
function makeFakeSsm(): jest.Mocked<SsmEnvStore> {
  return {
    save: jest.fn(async () => {}),
    get: jest.fn(async () => null),
    delete: jest.fn(async () => {}),
  } as unknown as jest.Mocked<SsmEnvStore>;
}

describe('AgentsService', () => {
  let repo: jest.Mocked<AgentsRepository>;
  let ssm: jest.Mocked<SsmEnvStore>;
  let service: AgentsService;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = makeFakeRepo();
    ssm = makeFakeSsm();
    service = new AgentsService(repo, ssm);
  });

  describe('createAgent', () => {
    it('persists a private agent and stamps ids onto scenarios', async () => {
      const created = await service.createAgent(USER_ID, {
        name: 'New Agent',
        description: 'desc',
        systemPrompt: 'sys',
        enabledTools: [],
        scenarios: [{ title: 't', prompt: 'p' }],
      });

      expect(repo.put).toHaveBeenCalledTimes(1);
      const persisted = repo.put.mock.calls[0][0];
      expect(persisted.isShared).toBe(false);
      expect(persisted.scenarios[0].id).toBe('test-uuid-1234');
      expect(created.isShared).toBe(false);
    });

    it('does not touch SSM when there is no mcpConfig', async () => {
      await service.createAgent(USER_ID, {
        name: 'n',
        description: 'd',
        systemPrompt: 's',
        enabledTools: [],
        scenarios: [],
      });
      expect(ssm.save).not.toHaveBeenCalled();
    });
  });

  describe('getAgent', () => {
    it('returns null when the repo has no such agent', async () => {
      repo.get.mockResolvedValueOnce(null);
      expect(await service.getAgent(USER_ID, AGENT_ID)).toBeNull();
    });

    it('restores SSM env into mcpConfig when a sentinel is present', async () => {
      repo.get.mockResolvedValueOnce(
        makeAgent({
          // The stored config carries the SSM sentinel ({ __ssm: true }) in place
          // of real env; envMap is keyed by server name.
          mcpConfig: {
            mcpServers: { s: { command: 'x', env: { __ssm: true } as never } },
          },
        })
      );
      ssm.get.mockResolvedValueOnce({ s: { KEY: 'secret-value' } });

      const agent = await service.getAgent(USER_ID, AGENT_ID);

      expect(ssm.get).toHaveBeenCalledWith(USER_ID, AGENT_ID);
      expect(agent?.mcpConfig?.mcpServers.s.env?.KEY).toBe('secret-value');
    });
  });

  describe('updateAgent', () => {
    it('stamps scenario ids and forwards a storage-ready patch to the repo', async () => {
      await service.updateAgent(USER_ID, {
        agentId: AGENT_ID,
        name: 'renamed',
        scenarios: [{ title: 't', prompt: 'p' }],
      });

      expect(repo.update).toHaveBeenCalledTimes(1);
      const [, , patch] = repo.update.mock.calls[0] as [UserId, AgentId, UpdateAgentPatch];
      expect(patch.name).toBe('renamed');
      expect(patch.scenarios?.[0].id).toBe('test-uuid-1234');
    });

    it('extracts mcpConfig env to SSM and patches the sanitized config', async () => {
      await service.updateAgent(USER_ID, {
        agentId: AGENT_ID,
        mcpConfig: { mcpServers: { s: { command: 'x', env: { KEY: 'plain-secret' } } } },
      });

      expect(ssm.save).toHaveBeenCalledTimes(1);
      const [, , patch] = repo.update.mock.calls[0] as [UserId, AgentId, UpdateAgentPatch];
      // The persisted config must not carry the raw secret.
      expect(patch.mcpConfig?.mcpServers.s.env?.KEY).not.toBe('plain-secret');
    });

    it('propagates AgentNotFoundError from the repo', async () => {
      repo.update.mockRejectedValueOnce(new AgentNotFoundError());
      await expect(
        service.updateAgent(USER_ID, { agentId: AGENT_ID, name: 'x' })
      ).rejects.toBeInstanceOf(AgentNotFoundError);
    });

    it('does NOT write or delete SSM when the agent does not exist (no orphaned params)', async () => {
      // The existence gate (repo.update's ConditionExpression) must run before
      // any SSM mutation: a mcpConfig update to a missing/other-user agent must
      // not leave an orphaned — or delete an unrelated — SSM parameter.
      repo.update.mockRejectedValueOnce(new AgentNotFoundError());

      await expect(
        service.updateAgent(USER_ID, {
          agentId: AGENT_ID,
          mcpConfig: { mcpServers: { s: { command: 'x', env: { KEY: 'plain-secret' } } } },
        })
      ).rejects.toBeInstanceOf(AgentNotFoundError);

      expect(ssm.save).not.toHaveBeenCalled();
      expect(ssm.delete).not.toHaveBeenCalled();
    });

    it('writes SSM env only after the row update succeeds', async () => {
      // Ordering guard: ssm.save must happen after repo.update resolves.
      const order: string[] = [];
      ssm.save.mockImplementationOnce(async () => {
        order.push('ssm.save');
      });
      repo.update.mockImplementationOnce(async () => {
        order.push('repo.update');
        return makeAgent();
      });

      await service.updateAgent(USER_ID, {
        agentId: AGENT_ID,
        mcpConfig: { mcpServers: { s: { command: 'x', env: { KEY: 'plain-secret' } } } },
      });

      expect(order).toEqual(['repo.update', 'ssm.save']);
    });
  });

  describe('deleteAgent', () => {
    it('removes the SSM parameter before deleting the row', async () => {
      await service.deleteAgent(USER_ID, AGENT_ID);
      expect(ssm.delete).toHaveBeenCalledWith(USER_ID, AGENT_ID);
      expect(repo.delete).toHaveBeenCalledWith(USER_ID, AGENT_ID);
    });
  });

  describe('toggleShare', () => {
    it('delegates to the repo and returns the updated agent', async () => {
      repo.toggleShare.mockResolvedValueOnce(makeAgent({ isShared: true }));
      const result = await service.toggleShare(USER_ID, AGENT_ID);
      expect(repo.toggleShare).toHaveBeenCalledWith(USER_ID, AGENT_ID);
      expect(result.isShared).toBe(true);
    });

    it('propagates AgentNotFoundError from the repo', async () => {
      repo.toggleShare.mockRejectedValueOnce(new AgentNotFoundError());
      await expect(service.toggleShare(USER_ID, AGENT_ID)).rejects.toBeInstanceOf(
        AgentNotFoundError
      );
    });
  });

  describe('listSharedAgents — cursor + filter policy', () => {
    it('decodes a base64 cursor and passes it to the repo as exclusiveStartKey', async () => {
      const startKey = { userId: 'u1', agentId: 'a1', isShared: 'true' };
      const cursor = Buffer.from(JSON.stringify(startKey)).toString('base64');
      repo.listShared.mockResolvedValueOnce({ agents: [makeAgent({ isShared: true })] });

      await service.listSharedAgents(10, undefined, cursor);

      expect(repo.listShared).toHaveBeenCalledWith(10, startKey);
    });

    it('throws "Invalid pagination cursor" for a malformed cursor', async () => {
      await expect(service.listSharedAgents(10, undefined, 'not-valid!!!')).rejects.toThrow(
        'Invalid pagination cursor'
      );
    });

    it('encodes the repo lastEvaluatedKey as the next cursor', async () => {
      const lastKey = { userId: 'u1', agentId: 'a1', isShared: 'true' };
      repo.listShared.mockResolvedValueOnce({
        agents: [makeAgent({ isShared: true })],
        lastEvaluatedKey: lastKey,
      });

      const result = await service.listSharedAgents(10);

      expect(result.hasMore).toBe(true);
      const decoded = JSON.parse(Buffer.from(result.nextCursor!, 'base64').toString('utf-8'));
      expect(decoded).toEqual(lastKey);
    });

    it('returns hasMore: false when the repo reports no lastEvaluatedKey', async () => {
      repo.listShared.mockResolvedValueOnce({ agents: [makeAgent({ isShared: true })] });
      const result = await service.listSharedAgents(10);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeUndefined();
    });

    it('filters agents by searchQuery (case-insensitive)', async () => {
      repo.listShared.mockResolvedValueOnce({
        agents: [
          makeAgent({ agentId: 'a1' as AgentId, name: 'Code Helper', isShared: true }),
          makeAgent({ agentId: 'a2' as AgentId, name: 'Writing Assistant', isShared: true }),
        ],
      });

      const result = await service.listSharedAgents(10, 'code');

      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('Code Helper');
    });
  });

  describe('cloneAgent', () => {
    it('clones a shared agent into the target user with a new id and isShared=false', async () => {
      repo.get.mockResolvedValueOnce(
        makeAgent({
          userId: 'source-user' as UserId,
          agentId: 'source-agent' as AgentId,
          name: 'Shared Agent',
          systemPrompt: 'Be helpful',
          isShared: true,
        })
      );

      const cloned = await service.cloneAgent(
        'target-user' as UserId,
        'source-user' as UserId,
        'source-agent' as AgentId,
        'targetuser'
      );

      expect(cloned.name).toBe('Shared Agent');
      expect(cloned.userId).toBe('target-user');
      expect(cloned.agentId).not.toBe('source-agent');
      expect(cloned.isShared).toBe(false);
      expect(repo.put).toHaveBeenCalledTimes(1);
    });

    it('throws AgentNotFoundError when cloning a non-shared agent', async () => {
      repo.get.mockResolvedValueOnce(makeAgent({ isShared: false }));
      await expect(
        service.cloneAgent('target-user' as UserId, USER_ID, AGENT_ID)
      ).rejects.toBeInstanceOf(AgentNotFoundError);
    });

    it('throws AgentNotFoundError when the source agent does not exist', async () => {
      repo.get.mockResolvedValueOnce(null);
      await expect(
        service.cloneAgent('target-user' as UserId, USER_ID, AGENT_ID)
      ).rejects.toBeInstanceOf(AgentNotFoundError);
    });
  });

  describe('getSharedAgent', () => {
    it('returns null for an agent that is not shared (no leaking private agents)', async () => {
      repo.get.mockResolvedValueOnce(makeAgent({ isShared: false }));
      expect(await service.getSharedAgent(USER_ID, AGENT_ID)).toBeNull();
    });

    it('strips mcpConfig env from a shared agent (non-owners must not see secrets)', async () => {
      repo.get.mockResolvedValueOnce(
        makeAgent({
          isShared: true,
          mcpConfig: { mcpServers: { s: { command: 'x', env: { SECRET: 'value' } } } },
        })
      );

      const shared = await service.getSharedAgent(USER_ID, AGENT_ID);

      expect(shared).not.toBeNull();
      // env must be gone entirely — the strip removes the key, not just the value.
      expect(shared!.mcpConfig?.mcpServers.s.env).toBeUndefined();
    });
  });
});
