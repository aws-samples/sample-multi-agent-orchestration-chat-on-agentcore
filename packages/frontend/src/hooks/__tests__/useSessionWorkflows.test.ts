// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { WorkflowView } from '../../types/workflow';
import type { Message } from '../../types/index';

const getWorkflow = vi.fn();
vi.mock('../../api/workflows', async (orig) => ({
  ...(await orig<typeof import('../../api/workflows')>()),
  getWorkflow: (id: string) => getWorkflow(id),
}));

const { useSessionWorkflows } = await import('../useSessionWorkflows');
const { useChatStore } = await import('../../stores/chatStore');
const { useWorkflowStore } = await import('../../stores/workflowStore');

const WF_RUNNING = 'wf-01a1c5fd-fbe4-7719-8d8e-24e7004f5495';
const WF_DONE = 'wf-01a1c600-0000-7000-8000-000000000000';
const WF_GONE = 'wf-01a1c601-0000-7000-8000-000000000000';

const started = (toolUseId: string, workflowId: string): Message[] => [
  {
    id: `m-${toolUseId}`,
    type: 'assistant',
    timestamp: new Date(),
    contents: [
      {
        type: 'toolUse',
        toolUse: { id: toolUseId, name: 'run_workflow', input: { action: 'start' } },
      },
      {
        type: 'toolResult',
        toolResult: { toolUseId, content: JSON.stringify({ success: true, workflowId }) },
      },
    ],
  },
];
const view = (workflowId: string, status: WorkflowView['status']): WorkflowView => ({
  workflowId,
  status,
  spec: { goal: workflowId, steps: [] },
  createdAt: '2026-11-10T00:00:00Z',
  updatedAt: '2026-11-10T00:00:00Z',
  steps: [],
});

beforeEach(() => {
  vi.useFakeTimers();
  getWorkflow.mockReset().mockImplementation(async (id: string) => {
    if (id === WF_GONE) throw new Error('Workflow not found');
    return view(id, id === WF_DONE ? 'completed' : 'running');
  });
  useWorkflowStore.setState({ workflows: {}, seen: [] });
  useChatStore.setState({
    sessions: {
      s1: {
        messages: [...started('a', WF_DONE), ...started('b', WF_RUNNING), ...started('c', WF_GONE)],
        isLoading: false,
        error: null,
        lastUpdated: new Date(),
      },
    },
  } as never);
});
afterEach(() => vi.useRealTimers());

describe('useSessionWorkflows', () => {
  it('returns workflows newest first and keeps polling only the unfinished ones', async () => {
    const { result } = renderHook(() => useSessionWorkflows('s1', 1000));
    await act(async () => {});
    expect(result.current.map((w) => w.workflowId)).toEqual([WF_RUNNING, WF_DONE]);
    expect(getWorkflow.mock.calls.map(([id]) => id).sort()).toEqual(
      [WF_DONE, WF_GONE, WF_RUNNING].sort()
    );

    getWorkflow.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(getWorkflow.mock.calls.map(([id]) => id).sort()).toEqual([WF_GONE, WF_RUNNING].sort());
  });

  it('gives up on a workflow that keeps failing', async () => {
    renderHook(() => useSessionWorkflows('s1', 1000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(getWorkflow.mock.calls.filter(([id]) => id === WF_GONE)).toHaveLength(3);
  });
});
