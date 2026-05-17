/**
 * Integration tests for AgentsService
 * Tests against real DynamoDB table - runs only in local development.
 *
 * Prerequisites:
 * - AWS credentials configured
 * - AGENTS_TABLE_NAME environment variable set
 * - SSM_PARAMETER_PREFIX environment variable set
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { config as loadEnv } from 'dotenv';
import { AgentsService, type CreateAgentInput } from '../agents-service.js';
import type { UserId, AgentId } from '@moca/core';

// Load environment variables
loadEnv();

// Skip in CI or when required env vars are missing
const SKIP_INTEGRATION =
  !process.env.AGENTS_TABLE_NAME || !process.env.SSM_PARAMETER_PREFIX || process.env.CI === 'true';

const describeIntegration = SKIP_INTEGRATION ? describe.skip : describe;

// Test constants
const TEST_USER_ID = `test-user-integration-${Date.now()}` as UserId;
const TEST_USER_ID_2 = `test-user-integration-2-${Date.now()}` as UserId;
const TEST_USERNAME = 'integration-test-user';

describeIntegration('AgentsService Integration Tests', () => {
  let service: AgentsService;
  const createdAgentIds: Array<{ userId: UserId; agentId: AgentId }> = [];

  beforeAll(() => {
    service = new AgentsService(
      process.env.AGENTS_TABLE_NAME!,
      process.env.SSM_PARAMETER_PREFIX!,
      process.env.AWS_REGION || 'ap-northeast-1'
    );
  });

  // Cleanup: delete all agents created during tests
  afterAll(async () => {
    for (const { userId, agentId } of createdAgentIds) {
      try {
        await service.deleteAgent(userId, agentId);
      } catch {
        // Ignore errors during cleanup
      }
    }
  });

  // Helper to track created agents for cleanup
  const trackAgent = (userId: UserId, agentId: AgentId) => {
    createdAgentIds.push({ userId, agentId });
  };

  // Helper to create a basic agent input
  const createBasicInput = (overrides?: Partial<CreateAgentInput>): CreateAgentInput => ({
    name: `Test Agent ${Date.now()}`,
    description: 'Integration test agent',
    systemPrompt: 'You are a helpful assistant for testing.',
    enabledTools: ['read_file', 'write_file'],
    scenarios: [{ title: 'Test Scenario', prompt: 'Hello, test!' }],
    ...overrides,
  });

  // ──────────────────────────────────────────────
  // createAgent
  // ──────────────────────────────────────────────

  describe('createAgent', () => {
    it('should create an agent with required fields', async () => {
      const input = createBasicInput();
      const agent = await service.createAgent(TEST_USER_ID, input, TEST_USERNAME);
      trackAgent(TEST_USER_ID, agent.agentId);

      expect(agent.userId).toBe(TEST_USER_ID);
      expect(agent.agentId).toBeDefined();
      expect(agent.name).toBe(input.name);
      expect(agent.description).toBe(input.description);
      expect(agent.systemPrompt).toBe(input.systemPrompt);
      expect(agent.enabledTools).toEqual(input.enabledTools);
      expect(agent.scenarios).toHaveLength(1);
      expect(agent.scenarios[0].title).toBe('Test Scenario');
      expect(agent.scenarios[0].id).toBeDefined();
      expect(agent.isShared).toBe(false);
      expect(agent.createdBy).toBe(TEST_USERNAME);
      expect(agent.createdAt).toBeDefined();
      expect(agent.updatedAt).toBeDefined();
    });

    it('should create an agent with optional icon', async () => {
      const input = createBasicInput({ icon: 'Bot' });
      const agent = await service.createAgent(TEST_USER_ID, input, TEST_USERNAME);
      trackAgent(TEST_USER_ID, agent.agentId);

      expect(agent.icon).toBe('Bot');
    });

    it('should create an agent with defaultStoragePath', async () => {
      const input = createBasicInput({ defaultStoragePath: '/projects/test' });
      const agent = await service.createAgent(TEST_USER_ID, input, TEST_USERNAME);
      trackAgent(TEST_USER_ID, agent.agentId);

      expect(agent.defaultStoragePath).toBe('/projects/test');
    });

    it('should create an agent with mcpConfig', async () => {
      const input = createBasicInput({
        mcpConfig: {
          mcpServers: {
            'test-server': {
              command: 'npx',
              args: ['-y', 'test-mcp-server'],
              transport: 'stdio',
            },
          },
        },
      });
      const agent = await service.createAgent(TEST_USER_ID, input, TEST_USERNAME);
      trackAgent(TEST_USER_ID, agent.agentId);

      expect(agent.mcpConfig).toBeDefined();
      expect(agent.mcpConfig?.mcpServers['test-server']).toBeDefined();
      expect(agent.mcpConfig?.mcpServers['test-server'].command).toBe('npx');
    });
  });

  // ──────────────────────────────────────────────
  // getAgent
  // ──────────────────────────────────────────────

  describe('getAgent', () => {
    it('should return an existing agent', async () => {
      const input = createBasicInput({ name: 'GetAgent Test' });
      const created = await service.createAgent(TEST_USER_ID, input, TEST_USERNAME);
      trackAgent(TEST_USER_ID, created.agentId);

      const agent = await service.getAgent(TEST_USER_ID, created.agentId);

      expect(agent).not.toBeNull();
      expect(agent!.agentId).toBe(created.agentId);
      expect(agent!.name).toBe('GetAgent Test');
    });

    it('should return null for non-existent agent', async () => {
      const agent = await service.getAgent(TEST_USER_ID, 'non-existent-agent-id' as AgentId);

      expect(agent).toBeNull();
    });
  });

  // ──────────────────────────────────────────────
  // listAgents
  // ──────────────────────────────────────────────

  describe('listAgents', () => {
    it('should return empty array for user with no agents', async () => {
      const uniqueUserId = `test-user-empty-${Date.now()}` as UserId;
      const agents = await service.listAgents(uniqueUserId);

      expect(agents).toEqual([]);
    });

    it('should return all agents for a user', async () => {
      const uniqueUserId = `test-user-list-${Date.now()}` as UserId;

      // Create multiple agents
      const agent1 = await service.createAgent(
        uniqueUserId,
        createBasicInput({ name: 'List Agent 1' }),
        TEST_USERNAME
      );
      trackAgent(uniqueUserId, agent1.agentId);

      const agent2 = await service.createAgent(
        uniqueUserId,
        createBasicInput({ name: 'List Agent 2' }),
        TEST_USERNAME
      );
      trackAgent(uniqueUserId, agent2.agentId);

      const agents = await service.listAgents(uniqueUserId);

      expect(agents.length).toBeGreaterThanOrEqual(2);
      const names = agents.map((a) => a.name);
      expect(names).toContain('List Agent 1');
      expect(names).toContain('List Agent 2');
    });
  });

  // ──────────────────────────────────────────────
  // updateAgent
  // ──────────────────────────────────────────────

  describe('updateAgent', () => {
    it('should update agent name', async () => {
      const created = await service.createAgent(
        TEST_USER_ID,
        createBasicInput({ name: 'Original Name' }),
        TEST_USERNAME
      );
      trackAgent(TEST_USER_ID, created.agentId);

      const updated = await service.updateAgent(TEST_USER_ID, {
        agentId: created.agentId,
        name: 'Updated Name',
      });

      expect(updated.name).toBe('Updated Name');
      expect(updated.description).toBe(created.description); // unchanged
    });

    it('should update agent description', async () => {
      const created = await service.createAgent(TEST_USER_ID, createBasicInput(), TEST_USERNAME);
      trackAgent(TEST_USER_ID, created.agentId);

      const updated = await service.updateAgent(TEST_USER_ID, {
        agentId: created.agentId,
        description: 'Updated description',
      });

      expect(updated.description).toBe('Updated description');
    });

    it('should update agent icon', async () => {
      const created = await service.createAgent(
        TEST_USER_ID,
        createBasicInput({ icon: 'Bot' }),
        TEST_USERNAME
      );
      trackAgent(TEST_USER_ID, created.agentId);

      const updated = await service.updateAgent(TEST_USER_ID, {
        agentId: created.agentId,
        icon: 'Code',
      });

      expect(updated.icon).toBe('Code');
    });

    it('should update agent systemPrompt', async () => {
      const created = await service.createAgent(TEST_USER_ID, createBasicInput(), TEST_USERNAME);
      trackAgent(TEST_USER_ID, created.agentId);

      const updated = await service.updateAgent(TEST_USER_ID, {
        agentId: created.agentId,
        systemPrompt: 'New system prompt',
      });

      expect(updated.systemPrompt).toBe('New system prompt');
    });

    it('should update agent enabledTools', async () => {
      const created = await service.createAgent(TEST_USER_ID, createBasicInput(), TEST_USERNAME);
      trackAgent(TEST_USER_ID, created.agentId);

      const updated = await service.updateAgent(TEST_USER_ID, {
        agentId: created.agentId,
        enabledTools: ['search_files'],
      });

      expect(updated.enabledTools).toEqual(['search_files']);
    });

    it('should update agent scenarios', async () => {
      const created = await service.createAgent(TEST_USER_ID, createBasicInput(), TEST_USERNAME);
      trackAgent(TEST_USER_ID, created.agentId);

      const updated = await service.updateAgent(TEST_USER_ID, {
        agentId: created.agentId,
        scenarios: [
          { title: 'New Scenario 1', prompt: 'Prompt 1' },
          { title: 'New Scenario 2', prompt: 'Prompt 2' },
        ],
      });

      expect(updated.scenarios).toHaveLength(2);
      expect(updated.scenarios[0].title).toBe('New Scenario 1');
      expect(updated.scenarios[1].title).toBe('New Scenario 2');
      // Scenarios should have new IDs
      expect(updated.scenarios[0].id).toBeDefined();
      expect(updated.scenarios[1].id).toBeDefined();
    });

    it('should update agent defaultStoragePath', async () => {
      const created = await service.createAgent(
        TEST_USER_ID,
        createBasicInput({ defaultStoragePath: '/old/path' }),
        TEST_USERNAME
      );
      trackAgent(TEST_USER_ID, created.agentId);

      const updated = await service.updateAgent(TEST_USER_ID, {
        agentId: created.agentId,
        defaultStoragePath: '/new/path',
      });

      expect(updated.defaultStoragePath).toBe('/new/path');
    });

    it('should clear defaultStoragePath when set to empty string', async () => {
      const created = await service.createAgent(
        TEST_USER_ID,
        createBasicInput({ defaultStoragePath: '/some/path' }),
        TEST_USERNAME
      );
      trackAgent(TEST_USER_ID, created.agentId);

      // Verify initial state
      expect(created.defaultStoragePath).toBe('/some/path');

      // Clear by setting to empty string
      const updated = await service.updateAgent(TEST_USER_ID, {
        agentId: created.agentId,
        defaultStoragePath: '',
      });

      // Should be undefined (attribute removed from DynamoDB)
      expect(updated.defaultStoragePath).toBeUndefined();

      // Verify by fetching again
      const fetched = await service.getAgent(TEST_USER_ID, created.agentId);
      expect(fetched!.defaultStoragePath).toBeUndefined();
    });

    it('should throw error when updating non-existent agent', async () => {
      await expect(
        service.updateAgent(TEST_USER_ID, {
          agentId: 'non-existent-agent-id' as AgentId,
          name: 'New Name',
        })
      ).rejects.toThrow('Agent not found');
    });
  });

  // ──────────────────────────────────────────────
  // deleteAgent
  // ──────────────────────────────────────────────

  describe('deleteAgent', () => {
    it('should delete an existing agent', async () => {
      const created = await service.createAgent(
        TEST_USER_ID,
        createBasicInput({ name: 'To Be Deleted' }),
        TEST_USERNAME
      );
      // Don't track - we're deleting it manually

      await service.deleteAgent(TEST_USER_ID, created.agentId);

      const agent = await service.getAgent(TEST_USER_ID, created.agentId);
      expect(agent).toBeNull();
    });

    it('should not throw when deleting non-existent agent', async () => {
      // DynamoDB DeleteItem doesn't throw for non-existent keys
      await expect(
        service.deleteAgent(TEST_USER_ID, 'non-existent-agent-id' as AgentId)
      ).resolves.not.toThrow();
    });
  });

  // ──────────────────────────────────────────────
  // toggleShare
  // ──────────────────────────────────────────────

  describe('toggleShare', () => {
    it('should toggle isShared from false to true', async () => {
      const created = await service.createAgent(TEST_USER_ID, createBasicInput(), TEST_USERNAME);
      trackAgent(TEST_USER_ID, created.agentId);

      expect(created.isShared).toBe(false);

      const toggled = await service.toggleShare(TEST_USER_ID, created.agentId);

      expect(toggled.isShared).toBe(true);
    });

    it('should toggle isShared from true to false', async () => {
      const created = await service.createAgent(TEST_USER_ID, createBasicInput(), TEST_USERNAME);
      trackAgent(TEST_USER_ID, created.agentId);

      // Toggle to true first
      await service.toggleShare(TEST_USER_ID, created.agentId);

      // Toggle back to false
      const toggled = await service.toggleShare(TEST_USER_ID, created.agentId);

      expect(toggled.isShared).toBe(false);
    });

    it('should throw error when toggling non-existent agent', async () => {
      await expect(
        service.toggleShare(TEST_USER_ID, 'non-existent-agent-id' as AgentId)
      ).rejects.toThrow('Agent not found');
    });
  });

  // ──────────────────────────────────────────────
  // listSharedAgents
  // ──────────────────────────────────────────────

  describe('listSharedAgents', () => {
    it('should return shared agents', async () => {
      const created = await service.createAgent(
        TEST_USER_ID,
        createBasicInput({ name: `Shared Agent ${Date.now()}` }),
        TEST_USERNAME
      );
      trackAgent(TEST_USER_ID, created.agentId);

      // Make it shared
      await service.toggleShare(TEST_USER_ID, created.agentId);

      const result = await service.listSharedAgents(100);

      expect(result.items.length).toBeGreaterThanOrEqual(1);
      const found = result.items.find((a) => a.agentId === created.agentId);
      expect(found).toBeDefined();
      expect(found!.isShared).toBe(true);
    });

    it('should filter by search query (case-insensitive)', async () => {
      const uniqueName = `SearchableAgent-${Date.now()}`;
      const created = await service.createAgent(
        TEST_USER_ID,
        createBasicInput({ name: uniqueName }),
        TEST_USERNAME
      );
      trackAgent(TEST_USER_ID, created.agentId);

      await service.toggleShare(TEST_USER_ID, created.agentId);

      const result = await service.listSharedAgents(100, 'searchableagent');

      const found = result.items.find((a) => a.agentId === created.agentId);
      expect(found).toBeDefined();
    });

    it('should support pagination with cursor', async () => {
      // Create multiple shared agents
      const agents: AgentId[] = [];
      for (let i = 0; i < 3; i++) {
        const created = await service.createAgent(
          TEST_USER_ID,
          createBasicInput({ name: `Paginated Agent ${i} - ${Date.now()}` }),
          TEST_USERNAME
        );
        trackAgent(TEST_USER_ID, created.agentId);
        await service.toggleShare(TEST_USER_ID, created.agentId);
        agents.push(created.agentId);
      }

      // Fetch first page with limit 1
      const page1 = await service.listSharedAgents(1);
      expect(page1.items.length).toBe(1);

      if (page1.hasMore && page1.nextCursor) {
        // Fetch next page
        const page2 = await service.listSharedAgents(1, undefined, page1.nextCursor);
        expect(page2.items.length).toBe(1);
        // Should be different agents
        expect(page2.items[0].agentId).not.toBe(page1.items[0].agentId);
      }
    });

    it('should throw error for invalid cursor', async () => {
      await expect(service.listSharedAgents(10, undefined, 'invalid-cursor')).rejects.toThrow(
        'Invalid pagination cursor'
      );
    });
  });

  // ──────────────────────────────────────────────
  // getSharedAgent
  // ──────────────────────────────────────────────

  describe('getSharedAgent', () => {
    it('should return a shared agent', async () => {
      const created = await service.createAgent(TEST_USER_ID, createBasicInput(), TEST_USERNAME);
      trackAgent(TEST_USER_ID, created.agentId);

      await service.toggleShare(TEST_USER_ID, created.agentId);

      const agent = await service.getSharedAgent(TEST_USER_ID, created.agentId);

      expect(agent).not.toBeNull();
      expect(agent!.agentId).toBe(created.agentId);
      expect(agent!.isShared).toBe(true);
    });

    it('should return null for non-shared agent', async () => {
      const created = await service.createAgent(TEST_USER_ID, createBasicInput(), TEST_USERNAME);
      trackAgent(TEST_USER_ID, created.agentId);

      // Not shared
      const agent = await service.getSharedAgent(TEST_USER_ID, created.agentId);

      expect(agent).toBeNull();
    });

    it('should return null for non-existent agent', async () => {
      const agent = await service.getSharedAgent(TEST_USER_ID, 'non-existent-agent-id' as AgentId);

      expect(agent).toBeNull();
    });

    it('should strip env values from mcpConfig for security', async () => {
      const created = await service.createAgent(
        TEST_USER_ID,
        createBasicInput({
          mcpConfig: {
            mcpServers: {
              'test-server': {
                command: 'npx',
                args: ['-y', 'test-server'],
                env: {
                  API_KEY: 'secret-key-12345',
                  SECRET_TOKEN: 'secret-token-67890',
                },
                transport: 'stdio',
              },
            },
          },
        }),
        TEST_USERNAME
      );
      trackAgent(TEST_USER_ID, created.agentId);

      await service.toggleShare(TEST_USER_ID, created.agentId);

      const sharedAgent = await service.getSharedAgent(TEST_USER_ID, created.agentId);

      expect(sharedAgent).not.toBeNull();
      // Env should be stripped or empty
      const serverConfig = sharedAgent!.mcpConfig?.mcpServers['test-server'];
      expect(serverConfig?.env).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────
  // cloneAgent
  // ──────────────────────────────────────────────

  describe('cloneAgent', () => {
    it('should clone a shared agent to a new user', async () => {
      const sourceAgent = await service.createAgent(
        TEST_USER_ID,
        createBasicInput({
          name: 'Source Agent for Clone',
          description: 'Original description',
          icon: 'Brain',
          defaultStoragePath: '/shared/workspace',
        }),
        TEST_USERNAME
      );
      trackAgent(TEST_USER_ID, sourceAgent.agentId);

      await service.toggleShare(TEST_USER_ID, sourceAgent.agentId);

      const cloned = await service.cloneAgent(
        TEST_USER_ID_2,
        TEST_USER_ID,
        sourceAgent.agentId,
        'clone-user'
      );
      trackAgent(TEST_USER_ID_2, cloned.agentId);

      expect(cloned.userId).toBe(TEST_USER_ID_2);
      expect(cloned.agentId).not.toBe(sourceAgent.agentId); // New ID
      expect(cloned.name).toBe('Source Agent for Clone');
      expect(cloned.description).toBe('Original description');
      expect(cloned.icon).toBe('Brain');
      expect(cloned.defaultStoragePath).toBe('/shared/workspace');
      expect(cloned.isShared).toBe(false); // Cloned agent is not shared by default
      expect(cloned.createdBy).toBe('clone-user');
    });

    it('should throw error when cloning non-shared agent', async () => {
      const created = await service.createAgent(TEST_USER_ID, createBasicInput(), TEST_USERNAME);
      trackAgent(TEST_USER_ID, created.agentId);

      // Not shared
      await expect(
        service.cloneAgent(TEST_USER_ID_2, TEST_USER_ID, created.agentId, 'clone-user')
      ).rejects.toThrow('Shared agent not found');
    });

    it('should throw error when cloning non-existent agent', async () => {
      await expect(
        service.cloneAgent(
          TEST_USER_ID_2,
          TEST_USER_ID,
          'non-existent-agent-id' as AgentId,
          'clone-user'
        )
      ).rejects.toThrow('Shared agent not found');
    });

    it('should not copy env values from mcpConfig', async () => {
      const sourceAgent = await service.createAgent(
        TEST_USER_ID,
        createBasicInput({
          mcpConfig: {
            mcpServers: {
              'secret-server': {
                command: 'node',
                args: ['server.js'],
                env: {
                  SECRET_KEY: 'super-secret-value',
                },
                transport: 'stdio',
              },
            },
          },
        }),
        TEST_USERNAME
      );
      trackAgent(TEST_USER_ID, sourceAgent.agentId);

      await service.toggleShare(TEST_USER_ID, sourceAgent.agentId);

      const cloned = await service.cloneAgent(
        TEST_USER_ID_2,
        TEST_USER_ID,
        sourceAgent.agentId,
        'clone-user'
      );
      trackAgent(TEST_USER_ID_2, cloned.agentId);

      // Cloned agent should not have env values
      const serverConfig = cloned.mcpConfig?.mcpServers['secret-server'];
      expect(serverConfig?.env).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────
  // initializeDefaultAgents
  // ──────────────────────────────────────────────

  describe('initializeDefaultAgents', () => {
    it('should create multiple default agents', async () => {
      const uniqueUserId = `test-user-init-${Date.now()}` as UserId;

      const defaultAgents: CreateAgentInput[] = [
        createBasicInput({ name: 'Default Agent 1' }),
        createBasicInput({ name: 'Default Agent 2' }),
      ];

      const created = await service.initializeDefaultAgents(
        uniqueUserId,
        defaultAgents,
        TEST_USERNAME
      );

      // Track for cleanup
      for (const agent of created) {
        trackAgent(uniqueUserId, agent.agentId);
      }

      expect(created).toHaveLength(2);
      expect(created[0].name).toBe('Default Agent 1');
      expect(created[1].name).toBe('Default Agent 2');
    });
  });
});
