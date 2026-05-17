/**
 * Unit tests for AgentsService
 * Tests toDynamoAgent and fromDynamoAgent conversion logic indirectly
 * through the public service methods by mocking DynamoDB.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
  PutItemCommand: jest.fn(),
  GetItemCommand: jest.fn(),
  QueryCommand: jest.fn(),
  UpdateItemCommand: jest.fn(),
  DeleteItemCommand: jest.fn(),
}));

jest.mock('@aws-sdk/util-dynamodb', () => ({
  marshall: jest.fn((item: unknown) => item),
  unmarshall: jest.fn((item: unknown) => item),
}));

jest.mock('../../config/index', () => ({
  config: {
    AGENTS_TABLE_NAME: 'test-agents-table',
    AWS_REGION: 'us-east-1',
  },
}));

jest.mock('uuid', () => ({
  v7: jest.fn(() => 'test-uuid-1234'),
}));

import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { AgentsService } from '../agents-service.js';
import type { UserId, AgentId } from '@moca/core';

const TABLE_NAME = 'test-agents-table';
const USER_ID = 'user-123' as UserId;
const AGENT_ID = 'agent-456' as AgentId;

const baseDynamoAgent = {
  userId: USER_ID,
  agentId: AGENT_ID,
  name: 'Test Agent',
  description: 'A test agent',
  systemPrompt: 'You are helpful',
  enabledTools: [],
  scenarios: [],
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'testuser',
};

describe('AgentsService', () => {
  let service: AgentsService;

  let mockSend: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend = jest.fn();
    (DynamoDBClient as jest.Mock).mockImplementation(() => ({ send: mockSend }));
    service = new AgentsService(TABLE_NAME, 'us-east-1');
  });

  // ──────────────────────────────────────────────
  // isShared conversion: bool ↔ string
  // ──────────────────────────────────────────────

  describe('isShared conversion (toDynamoAgent)', () => {
    it('stores isShared as string "false" when creating an agent', async () => {
      mockSend.mockResolvedValueOnce({});

      await service.createAgent(USER_ID, {
        name: 'New Agent',
        description: 'desc',
        systemPrompt: 'sys',
        enabledTools: [],
        scenarios: [],
      });

      expect(PutItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({ isShared: 'false' }),
        })
      );
    });
  });

  describe('isShared conversion (fromDynamoAgent)', () => {
    it('converts isShared "true" string from DynamoDB to boolean true', async () => {
      mockSend.mockResolvedValueOnce({
        Items: [{ ...baseDynamoAgent, isShared: 'true' }],
      });

      const agents = await service.listAgents(USER_ID);

      expect(agents).toHaveLength(1);
      expect(agents[0].isShared).toBe(true);
    });

    it('converts isShared "false" string from DynamoDB to boolean false', async () => {
      mockSend.mockResolvedValueOnce({
        Items: [{ ...baseDynamoAgent, isShared: 'false' }],
      });

      const agents = await service.listAgents(USER_ID);

      expect(agents).toHaveLength(1);
      expect(agents[0].isShared).toBe(false);
    });
  });

  // ──────────────────────────────────────────────
  // toggleShare
  // ──────────────────────────────────────────────

  describe('toggleShare', () => {
    it('flips isShared from false to true and sends "true" to DynamoDB', async () => {
      // First call: getAgent (GetItemCommand)
      mockSend.mockResolvedValueOnce({
        Item: { ...baseDynamoAgent, isShared: 'false' },
      });
      // Second call: UpdateItemCommand
      mockSend.mockResolvedValueOnce({
        Attributes: { ...baseDynamoAgent, isShared: 'true' },
      });

      const result = await service.toggleShare(USER_ID, AGENT_ID);

      expect(result.isShared).toBe(true);
      expect(UpdateItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          ExpressionAttributeValues: expect.objectContaining({
            ':isShared': 'true',
          }),
        })
      );
    });

    it('flips isShared from true to false and sends "false" to DynamoDB', async () => {
      mockSend.mockResolvedValueOnce({
        Item: { ...baseDynamoAgent, isShared: 'true' },
      });
      mockSend.mockResolvedValueOnce({
        Attributes: { ...baseDynamoAgent, isShared: 'false' },
      });

      const result = await service.toggleShare(USER_ID, AGENT_ID);

      expect(result.isShared).toBe(false);
      expect(UpdateItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          ExpressionAttributeValues: expect.objectContaining({
            ':isShared': 'false',
          }),
        })
      );
    });

    it('throws if agent is not found', async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });

      await expect(service.toggleShare(USER_ID, AGENT_ID)).rejects.toThrow('Agent not found');
    });

    it('reads current state from DynamoDB before toggling', async () => {
      mockSend.mockResolvedValueOnce({
        Item: { ...baseDynamoAgent, isShared: 'false' },
      });
      mockSend.mockResolvedValueOnce({
        Attributes: { ...baseDynamoAgent, isShared: 'true' },
      });

      await service.toggleShare(USER_ID, AGENT_ID);

      // First call should be GetItemCommand
      expect(GetItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: expect.objectContaining({ userId: USER_ID, agentId: AGENT_ID }),
        })
      );
      // Second call should be UpdateItemCommand
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  // ──────────────────────────────────────────────
  // listSharedAgents cursor encoding/decoding
  // ──────────────────────────────────────────────

  describe('listSharedAgents', () => {
    it('decodes a valid base64 cursor and uses it as ExclusiveStartKey', async () => {
      const cursorPayload = { userId: 'u1', agentId: 'a1', isShared: 'true' };
      const cursor = Buffer.from(JSON.stringify(cursorPayload)).toString('base64');

      mockSend.mockResolvedValueOnce({
        Items: [{ ...baseDynamoAgent, isShared: 'true' }],
      });

      const result = await service.listSharedAgents(10, undefined, cursor);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].isShared).toBe(true);
    });

    it('throws "Invalid pagination cursor" for an invalid cursor', async () => {
      const invalidCursor = 'not-valid-base64-json!!!';

      await expect(service.listSharedAgents(10, undefined, invalidCursor)).rejects.toThrow(
        'Invalid pagination cursor'
      );
    });

    it('encodes LastEvaluatedKey as next cursor', async () => {
      const lastKey = { userId: 'u1', agentId: 'a1', isShared: 'true' };
      mockSend.mockResolvedValueOnce({
        Items: [{ ...baseDynamoAgent, isShared: 'true' }],
        LastEvaluatedKey: lastKey,
      });

      const result = await service.listSharedAgents(10);

      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBeDefined();
      const decoded = JSON.parse(Buffer.from(result.nextCursor!, 'base64').toString('utf-8'));
      expect(decoded).toEqual(lastKey);
    });

    it('returns hasMore: false when no LastEvaluatedKey', async () => {
      mockSend.mockResolvedValueOnce({
        Items: [{ ...baseDynamoAgent, isShared: 'true' }],
      });

      const result = await service.listSharedAgents(10);

      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeUndefined();
    });

    it('filters agents by searchQuery (case-insensitive)', async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          { ...baseDynamoAgent, agentId: 'a1', name: 'Code Helper', isShared: 'true' },
          { ...baseDynamoAgent, agentId: 'a2', name: 'Writing Assistant', isShared: 'true' },
        ],
      });

      const result = await service.listSharedAgents(10, 'code');

      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('Code Helper');
    });
  });

  // ──────────────────────────────────────────────
  // cloneAgent
  // ──────────────────────────────────────────────

  describe('cloneAgent', () => {
    it('clones a shared agent into the target user collection with a new ID', async () => {
      const sourceAgent = {
        ...baseDynamoAgent,
        userId: 'source-user',
        agentId: 'source-agent',
        name: 'Shared Agent',
        systemPrompt: 'Be helpful',
        isShared: 'true',
      };

      // getSharedAgent → getAgent (GetItemCommand)
      mockSend.mockResolvedValueOnce({ Item: sourceAgent });
      // createAgent (PutItemCommand)
      mockSend.mockResolvedValueOnce({});

      const cloned = await service.cloneAgent(
        'target-user' as UserId,
        'source-user' as UserId,
        'source-agent' as AgentId,
        'targetuser'
      );

      expect(cloned.name).toBe('Shared Agent');
      expect(cloned.systemPrompt).toBe('Be helpful');
      expect(cloned.userId).toBe('target-user');
      expect(cloned.agentId).not.toBe('source-agent');
      expect(cloned.isShared).toBe(false);
    });

    it('throws "Shared agent not found" when cloning a non-shared agent', async () => {
      mockSend.mockResolvedValueOnce({
        Item: { ...baseDynamoAgent, isShared: 'false' },
      });

      await expect(service.cloneAgent('target-user' as UserId, USER_ID, AGENT_ID)).rejects.toThrow(
        'Shared agent not found'
      );
    });

    it('throws "Shared agent not found" when source agent does not exist', async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });

      await expect(service.cloneAgent('target-user' as UserId, USER_ID, AGENT_ID)).rejects.toThrow(
        'Shared agent not found'
      );
    });
  });
});
