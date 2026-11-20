/**
 * Stop: the turn and the workflows the session started are stopped
 * together, and a stopped reply keeps its partial content plus a notice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatStore } from '../chatStore';
import { useSessionStore } from '../sessionStore';
import { useWorkflowStore } from '../workflowStore';
import { stopAgentTurn, streamAgentResponse } from '../../api/agent';
import i18n from '../../i18n';
import type { Message } from '../../types/index';

vi.mock('../../api/agent', () => ({ streamAgentResponse: vi.fn(), stopAgentTurn: vi.fn() }));

const SESSION_ID = 'abcdefghij0123456789ABCDEFGHIJ012';
const WF_RUNNING = 'wf-00000000-0000-0000-0000-000000000001';
const WF_DONE = 'wf-00000000-0000-0000-0000-000000000002';

function workflowStart(id: string, toolUseId: string): Message {
  return {
    id: `m-${toolUseId}`,
    type: 'assistant',
    timestamp: new Date(),
    contents: [
      {
        type: 'toolUse',
        toolUse: {
          id: toolUseId,
          name: 'run_workflow',
          input: { action: 'start' },
          status: 'completed',
        },
      },
      {
        type: 'toolResult',
        toolResult: {
          toolUseId,
          content: JSON.stringify({ success: true, workflowId: id }),
          isError: false,
        },
      },
    ],
  } as Message;
}

let cancel: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useChatStore.setState({ sessions: {}, activeSessionId: SESSION_ID, lastStreamCompletedAt: {} });
  useSessionStore.setState({ sessions: [] });
  cancel = vi.fn().mockResolvedValue(undefined);
  useWorkflowStore.setState({
    workflows: { [WF_DONE]: { data: { status: 'completed' } as never } },
    cancel,
  } as never);
  vi.mocked(stopAgentTurn).mockReset().mockResolvedValue(true);
});

describe('chatStore.stopPrompt', () => {
  it("stops the turn and cancels the session's unfinished workflows", async () => {
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [workflowStart(WF_RUNNING, 't1'), workflowStart(WF_DONE, 't2')],
          isLoading: true,
          error: null,
          lastUpdated: new Date(),
        },
      },
    });

    await expect(useChatStore.getState().stopPrompt(SESSION_ID)).resolves.toBe(true);

    expect(stopAgentTurn).toHaveBeenCalledWith(SESSION_ID);
    expect(cancel).toHaveBeenCalledWith(WF_RUNNING);
    expect(cancel).not.toHaveBeenCalledWith(WF_DONE);
  });

  it('still stops the turn when a workflow cancel fails', async () => {
    cancel.mockRejectedValue(new Error('boom'));
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [workflowStart(WF_RUNNING, 't1')],
          isLoading: true,
          error: null,
          lastUpdated: new Date(),
        },
      },
    });

    await expect(useChatStore.getState().stopPrompt(SESSION_ID)).resolves.toBe(true);
  });
});

describe('chatStore cancelled stream', () => {
  it('keeps the partial reply, adds the stopped notice and ends loading without an error', async () => {
    vi.mocked(streamAgentResponse).mockImplementation(async (_p, _s, callbacks) => {
      callbacks.onTextDelta?.('partial answer');
      callbacks.onCancel?.();
    });

    await useChatStore.getState().sendPrompt('write an essay', SESSION_ID);

    const state = useChatStore.getState().sessions[SESSION_ID]!;
    const assistant = state.messages.find((m) => m.type === 'assistant')!;
    const text = assistant.contents.map((c) => c.text ?? '').join('');
    expect(text).toContain('partial answer');
    expect(text).toContain(i18n.t('chat.generationStopped'));
    expect(assistant.isStreaming).toBe(false);
    expect(assistant.isError).toBeFalsy();
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
  });
});
