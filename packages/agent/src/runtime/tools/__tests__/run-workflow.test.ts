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
