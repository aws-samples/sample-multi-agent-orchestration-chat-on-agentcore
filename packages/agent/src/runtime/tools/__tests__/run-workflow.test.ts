/**
 * run_workflow start must flush the parent's workspace to S3 before the
 * Backend starts the execution — steps pull the parent's storagePath at once.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockGetCurrentContext = jest.fn<any>();

jest.unstable_mockModule('../../../config/index.js', () => ({
  config: { BACKEND_API_URL: 'https://api.test' },
}));
jest.unstable_mockModule('../../../libs/logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const listCallerAgents = jest.fn<any>();
jest.unstable_mockModule('../../../services/agent-registry.js', () => ({ listCallerAgents }));
jest.unstable_mockModule('../../../libs/context/request-context.js', () => ({
  getCurrentContext: mockGetCurrentContext,
  getCallerAuthorizationHeader: () => 'Bearer token',
  getCallerIdToken: () => 'id-token',
}));

const { runWorkflow } = await import('../run-workflow.js');

const fetchMock = jest.fn<any>();
const workflow = { goal: 'g', steps: [{ id: 'a', agentId: 'x', prompt: 'p' }] };

beforeEach(() => {
  jest.clearAllMocks();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockResolvedValue({
    ok: true,
    status: 202,
    text: async () => JSON.stringify({ workflowId: 'wf-1' }),
  });
});

describe('runWorkflow start', () => {
  it('syncs the workspace to S3 before calling the Backend', async () => {
    const order: string[] = [];
    const syncToS3 = jest.fn(async () => {
      order.push('sync');
      return { success: true };
    });
    fetchMock.mockImplementation(async () => {
      order.push('backend');
      return { ok: true, status: 202, text: async () => '{"workflowId":"wf-1"}' };
    });
    mockGetCurrentContext.mockReturnValue({ sessionId: 's', workspaceSync: { syncToS3 } });

    const result = await runWorkflow({ action: 'start', workflow });

    expect(result.success).toBe(true);
    expect(order).toEqual(['sync', 'backend']);
  });

  it('still starts the workflow when the sync throws', async () => {
    const syncToS3 = jest.fn(async () => {
      throw new Error('no credentials');
    });
    mockGetCurrentContext.mockReturnValue({ sessionId: 's', workspaceSync: { syncToS3 } });

    const result = await runWorkflow({ action: 'start', workflow });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('runWorkflow errors and discovery', () => {
  beforeEach(() => mockGetCurrentContext.mockReturnValue({ sessionId: 's' }));

  it('passes the Backend message (e.g. the concurrency limit) to the agent', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      text: async () =>
        JSON.stringify({ error: 'Conflict', message: 'Too many running workflows (3/3).' }),
    });
    const result = await runWorkflow({ action: 'start', workflow });
    expect(result).toMatchObject({
      success: false,
      status: 409,
      error: 'Too many running workflows (3/3).',
    });
  });

  it('rejects an unknown modelId before calling the Backend', async () => {
    const result = await runWorkflow({
      action: 'start',
      workflow: { goal: 'g', steps: [{ id: 'a', agentId: 'x', prompt: 'p', modelId: 'nope' }] },
    });
    expect(result.success).toBe(false);
    expect(String((result.problems as string[])[0])).toContain('unknown modelId "nope"');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists agents and model ids usable in steps', async () => {
    listCallerAgents.mockResolvedValue({
      ok: true,
      agents: [{ agentId: 'a1', name: 'Researcher', description: 'd' }],
    });
    const result = await runWorkflow({ action: 'agents' });
    expect(result.success).toBe(true);
    expect(result.agents).toEqual([{ agentId: 'a1', name: 'Researcher', description: 'd' }]);
    expect((result.models as Array<{ modelId: string }>).length).toBeGreaterThan(0);
  });

  it('reports a failed agent lookup instead of an empty list', async () => {
    listCallerAgents.mockResolvedValue({ ok: false, error: 'HTTP 401' });
    const result = await runWorkflow({ action: 'agents' });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('HTTP 401') });
  });
});
