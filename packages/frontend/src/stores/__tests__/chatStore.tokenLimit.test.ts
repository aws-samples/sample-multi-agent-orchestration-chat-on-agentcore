/**
 * Monthly token limits in the chat stream: a pre-turn refusal (serverErrorEvent
 * tokenLimitExceeded) and mid-turn stops (serverWarningEvent tokenLimitReached /
 * usageMeteringUnavailable).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { useChatStore } from '../chatStore';
import { useSessionStore } from '../sessionStore';
import { useUsageStore } from '../usageStore';
import { streamAgentResponse } from '../../api/agent';
import { ServerStreamError } from '../../utils/server-stream-error';
import i18n from '../../i18n';

vi.mock('../../api/agent', () => ({ streamAgentResponse: vi.fn() }));
vi.mock('react-hot-toast', () => {
  const fn = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() });
  return { default: fn };
});

const SESSION_ID = 'abcdefghij0123456789ABCDEFGHIJ012';
const RESETS_AT = '2026-11-30T15:00:00Z';

const assistant = () =>
  useChatStore.getState().sessions[SESSION_ID]!.messages.find((m) => m.type === 'assistant')!;

let fetchUsage: ReturnType<typeof vi.fn>;
let scheduleRefresh: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  useChatStore.setState({ sessions: {}, activeSessionId: SESSION_ID, lastStreamCompletedAt: {} });
  useSessionStore.setState({
    sessions: [{ sessionId: SESSION_ID, title: 't', createdAt: '', updatedAt: '' }],
    refreshSessions: vi.fn().mockResolvedValue(undefined),
  } as never);
  fetchUsage = vi.fn().mockResolvedValue(undefined);
  scheduleRefresh = vi.fn();
  useUsageStore.setState({ summary: null, fetchUsage, scheduleRefresh } as never);
});

const refuse = (beforeVerdict = () => {}) =>
  vi.mocked(streamAgentResponse).mockImplementation(async (_p, _s, callbacks) => {
    beforeVerdict();
    callbacks.onError?.(
      new ServerStreamError({
        message: 'Token limit exceeded',
        requestId: 'r',
        code: 'tokenLimitExceeded',
        modelKey: 'anthropic.claude-opus-5-5',
        dimension: 'output',
        used: 500_000,
        limit: 500_000,
        resetsAt: RESETS_AT,
      })
    );
  });

describe('chatStore tokenLimitExceeded (pre-turn refusal)', () => {
  it('shows the refusal with the limit, reset time and a resend option', async () => {
    refuse();
    await useChatStore.getState().sendPrompt('summarize', SESSION_ID);

    const message = assistant();
    expect(message.isError).toBe(true);
    expect(message.isStreaming).toBe(false);
    expect(message.errorTitle).toBe(i18n.t('chat.tokenLimitExceededTitle'));
    const text = message.contents.map((c) => c.text).join('');
    expect(text).toContain('Claude Opus 5.5');
    expect(text).toContain('500K / 500K');
    expect(text).toContain('12/1 00:00');
    expect(text).not.toContain('An error occurred');
    expect(message.tokenLimitRetry).toEqual({
      // Lets the resend replace this refused turn (see TokenLimitRetryButton).
      messageId: message.id,
      prompt: 'summarize',
      sessionId: SESSION_ID,
      modelKey: 'anthropic.claude-opus-5-5',
    });

    const state = useChatStore.getState().sessions[SESSION_ID]!;
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
    expect(fetchUsage).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('toasts when the refused session is not the one on screen', async () => {
    // The user moved to another session while the request was in flight.
    refuse(() => useChatStore.setState({ activeSessionId: 'another-session' }));
    await useChatStore.getState().sendPrompt('summarize', SESSION_ID);
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('Claude Opus 5.5'),
      expect.anything()
    );
  });

  it('keeps the generic error path for other server errors', async () => {
    vi.mocked(streamAgentResponse).mockImplementation(async (_p, _s, callbacks) => {
      callbacks.onError?.(new ServerStreamError({ message: 'boom', requestId: 'r' }));
    });
    await useChatStore.getState().sendPrompt('x', SESSION_ID);
    expect(assistant().tokenLimitRetry).toBeUndefined();
    expect(
      assistant()
        .contents.map((c) => c.text)
        .join('')
    ).toContain('boom');
  });
});

describe('chatStore mid-turn stops', () => {
  it('marks a tokenLimitReached turn as stopped, with the limit note below the answer', async () => {
    vi.mocked(streamAgentResponse).mockImplementation(async (_p, _s, callbacks) => {
      callbacks.onTextDelta?.('Partial findings');
      callbacks.onWarning?.({
        code: 'tokenLimitReached',
        message: 'limit',
        modelKey: 'anthropic.claude-sonnet-4-6',
        dimension: 'input',
        used: 100_000_000,
        limit: 100_000_000,
        resetsAt: RESETS_AT,
      });
      callbacks.onTextDelta?.(' and the summary.');
      callbacks.onComplete?.({});
    });

    await useChatStore.getState().sendPrompt('research', SESSION_ID);

    const message = assistant();
    expect(message.isError).toBe(true);
    expect(message.errorTitle).toBe(i18n.t('chat.tokenLimitReachedTitle'));
    expect(message.contents.map((c) => c.text).join('')).toBe('Partial findings and the summary.');
    expect(message.notice).toContain('Claude Sonnet 4.6');
    expect(message.notice).toContain('100M');
    expect(message.notice).toContain('12/1 00:00');
    expect(scheduleRefresh).toHaveBeenCalled();
  });

  it('explains a usageMeteringUnavailable stop', async () => {
    vi.mocked(streamAgentResponse).mockImplementation(async (_p, _s, callbacks) => {
      callbacks.onWarning?.({ code: 'usageMeteringUnavailable', message: 'm' });
      callbacks.onComplete?.({});
    });

    await useChatStore.getState().sendPrompt('research', SESSION_ID);

    expect(assistant().isError).toBe(true);
    expect(assistant().errorTitle).toBe(i18n.t('chat.usageMeteringUnavailableTitle'));
    expect(assistant().notice).toBe(i18n.t('chat.usageMeteringUnavailable'));
  });

  it('refreshes usage after a normal turn completes', async () => {
    vi.mocked(streamAgentResponse).mockImplementation(async (_p, _s, callbacks) => {
      callbacks.onComplete?.({});
    });
    await useChatStore.getState().sendPrompt('hi', SESSION_ID);
    expect(scheduleRefresh).toHaveBeenCalledTimes(1);
  });
});
