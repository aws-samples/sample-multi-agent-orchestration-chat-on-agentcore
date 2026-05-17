/**
 * Unit tests for AgentInvoker service
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { AgentInvoker } from '../agent-invoker.js';
import type { AgentsService } from '../agents-service.js';
import type { SchedulerEventPayload } from '../../types/index.js';
import type { TriggerId } from '@moca/core';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockAgent(overrides: Partial<ReturnType<typeof buildAgent>> = {}) {
  return buildAgent(overrides);
}

function buildAgent(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-123',
    agentId: 'agent-456',
    name: 'Test Agent',
    description: 'A test agent',
    systemPrompt: 'You are a helpful assistant.',
    enabledTools: ['tool-a'],
    scenarios: [],
    mcpConfig: undefined,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    isShared: false,
    createdBy: 'user-123',
    ...overrides,
  };
}

function makePayload(overrides: Partial<SchedulerEventPayload> = {}): SchedulerEventPayload {
  return {
    triggerId: '550e8400-e29b-41d4-a716-446655440000' as TriggerId,
    userId: 'user-123',
    agentId: 'agent-456',
    prompt: 'Hello, agent!',
    ...overrides,
  };
}

function makeAgentsService(
  agentOverrides: Record<string, unknown> = {}
): jest.Mocked<AgentsService> {
  return {
    getAgent: jest
      .fn<() => Promise<ReturnType<typeof buildAgent>>>()
      .mockResolvedValue(makeMockAgent(agentOverrides)),
  } as unknown as jest.Mocked<AgentsService>;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AgentInvoker', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.fn<typeof fetch>();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.AGENT_API_URL;
  });

  // ── encodeAgentUrl (tested via constructor + fetch call) ──────────────────

  describe('encodeAgentUrl (via URL passed to fetch)', () => {
    it('should percent-encode ARN containing slashes inside /runtimes/ path', async () => {
      const rawUrl =
        'https://xxx.bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn:aws:bedrock-agentcore:us-east-1:123456:runtime/my-runtime/invocations';
      const expectedEncodedArn = encodeURIComponent(
        'arn:aws:bedrock-agentcore:us-east-1:123456:runtime/my-runtime'
      );
      const expectedUrl = `https://xxx.bedrock-agentcore.us-east-1.amazonaws.com/runtimes/${expectedEncodedArn}/invocations`;

      const service = makeAgentsService();
      fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
      const invoker = new AgentInvoker(rawUrl, service);
      await invoker.invokeAsync(makePayload(), 'auth-token');

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toBe(expectedUrl);
    });

    it('should not modify URL that does not contain bedrock-agentcore', async () => {
      const url = 'https://example.com/runtimes/arn:something/my-agent/invocations';
      const service = makeAgentsService();
      fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
      const invoker = new AgentInvoker(url, service);
      await invoker.invokeAsync(makePayload(), 'token');

      expect(fetchMock.mock.calls[0][0] as string).toBe(url);
    });

    it('should not modify URL that has bedrock-agentcore but no /runtimes/arn: segment', async () => {
      const url = 'https://xxx.bedrock-agentcore.us-east-1.amazonaws.com/invocations';
      const service = makeAgentsService();
      fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
      const invoker = new AgentInvoker(url, service);
      await invoker.invokeAsync(makePayload(), 'token');

      expect(fetchMock.mock.calls[0][0] as string).toBe(url);
    });

    it('should handle URL that is already percent-encoded (no double-encoding)', async () => {
      const encodedArn = encodeURIComponent(
        'arn:aws:bedrock-agentcore:us-east-1:123456:runtime/my-runtime'
      );
      const alreadyEncoded = `https://xxx.bedrock-agentcore.us-east-1.amazonaws.com/runtimes/${encodedArn}/invocations`;

      const service = makeAgentsService();
      fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
      const invoker = new AgentInvoker(alreadyEncoded, service);
      await invoker.invokeAsync(makePayload(), 'token');

      // When the URL doesn't literally contain /runtimes/arn:, regex won't match → unchanged
      expect(fetchMock.mock.calls[0][0] as string).toBe(alreadyEncoded);
    });
  });

  // ── fromEnvironment ───────────────────────────────────────────────────────

  describe('fromEnvironment', () => {
    it('should throw when AGENT_API_URL is not set', () => {
      delete process.env.AGENT_API_URL;
      expect(() => AgentInvoker.fromEnvironment(makeAgentsService())).toThrow(
        'AGENT_API_URL environment variable is required'
      );
    });

    it('should create an instance when AGENT_API_URL is set', () => {
      process.env.AGENT_API_URL = 'https://api.example.com/invocations';
      const invoker = AgentInvoker.fromEnvironment(makeAgentsService());
      expect(invoker).toBeInstanceOf(AgentInvoker);
    });
  });

  // ── invokeAsync (fire-and-forget) ─────────────────────────────────────────

  describe('invokeAsync', () => {
    it('should return success without reading the stream', async () => {
      const service = makeAgentsService();
      fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

      const invoker = new AgentInvoker('https://api.example.com/invocations', service);
      const result = await invoker.invokeAsync(makePayload(), 'token');

      expect(result.success).toBe(true);
      expect(result.requestId).toBe('');
    });

    it('should return success=false when agent is not found', async () => {
      const service = {
        getAgent: jest.fn<() => Promise<null>>().mockResolvedValue(null),
      } as unknown as jest.Mocked<AgentsService>;

      const invoker = new AgentInvoker('https://api.example.com/invocations', service);
      const result = await invoker.invokeAsync(makePayload(), 'token');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Agent not found');
    });

    it('should return success=false on HTTP error', async () => {
      const service = makeAgentsService();
      fetchMock.mockResolvedValue(new Response('Service Unavailable', { status: 503 }));

      const invoker = new AgentInvoker('https://api.example.com/invocations', service);
      const result = await invoker.invokeAsync(makePayload(), 'token');

      expect(result.success).toBe(false);
      expect(result.error).toContain('503');
    });

    it('should call fetch with same URL encoding as invoke', async () => {
      const rawUrl =
        'https://xxx.bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn:aws:bedrock-agentcore:us-east-1:123456:runtime/my-runtime/invocations';
      const service = makeAgentsService();
      fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

      const invoker = new AgentInvoker(rawUrl, service);
      await invoker.invokeAsync(makePayload(), 'token');

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain('bedrock-agentcore');
      expect(calledUrl).not.toContain('/runtimes/arn:aws:bedrock-agentcore:');
      expect(calledUrl).toContain(
        encodeURIComponent('arn:aws:bedrock-agentcore:us-east-1:123456:runtime/my-runtime')
      );
    });
  });
});
