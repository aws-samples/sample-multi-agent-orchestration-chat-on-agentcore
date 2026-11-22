/**
 * The runtime reports "this turn is no longer being saved" as an
 * out-of-band serverWarningEvent (AC-3); it must reach the caller.
 */

import { describe, it, expect, vi } from 'vitest';
import { agentClient } from '../client/agent-client';
import { streamAgentResponse } from '../agent';
import {
  StreamDisconnectedError,
  StreamStalledError,
  STREAM_IDLE_TIMEOUT_MS,
} from '../../utils/stream-idle-watchdog';

vi.mock('../client/agent-client', () => ({ agentClient: { invoke: vi.fn() } }));
vi.mock('../agent-token-renewal', () => ({ startAgentTokenRenewal: () => () => {} }));

function ndjsonResponse(events: unknown[]): Response {
  const body = events.map((e) => `${JSON.stringify(e)}\n`).join('');
  return new Response(body, { status: 200 });
}

describe('streamAgentResponse warning events', () => {
  it('forwards serverWarningEvent to onWarning', async () => {
    vi.mocked(agentClient.invoke).mockResolvedValue(
      ndjsonResponse([
        {
          type: 'serverWarningEvent',
          warning: { code: 'persistenceDegraded', target: 'conversation', message: 'm' },
        },
      ])
    );
    const onWarning = vi.fn();

    await streamAgentResponse('hi', 'S'.repeat(33), { onWarning });

    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'persistenceDegraded' })
    );
  });
});

describe('streamAgentResponse turn-in-progress', () => {
  it('forwards serverTurnInProgressEvent to onTurnInProgress instead of onError', async () => {
    vi.mocked(agentClient.invoke).mockResolvedValue(
      ndjsonResponse([
        { type: 'serverTurnInProgressEvent', turn: { startedAt: '2026-11-01T00:00:00.000Z' } },
      ])
    );
    const onTurnInProgress = vi.fn();
    const onError = vi.fn();

    await streamAgentResponse('continue', 'S'.repeat(33), { onTurnInProgress, onError });

    expect(onTurnInProgress).toHaveBeenCalledWith({ startedAt: '2026-11-01T00:00:00.000Z' });
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('streamAgentResponse idle stream', () => {
  it('fails a stream that stops delivering so the caller can reattach (#157)', async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      const hung = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"type":"serverHeartbeatEvent"}\n'));
          // ...and then nothing, without closing or erroring.
        },
      });
      vi.mocked(agentClient.invoke).mockResolvedValue(new Response(hung, { status: 200 }));
      const onError = vi.fn();

      const done = streamAgentResponse('hi', 'S'.repeat(33), { onError });
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS);
      await done;

      expect(onError).toHaveBeenCalledWith(expect.any(StreamStalledError));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('streamAgentResponse failure classification', () => {
  it('reports a network failure as a disconnect, not a server verdict', async () => {
    vi.mocked(agentClient.invoke).mockRejectedValue(new TypeError('Load failed'));
    const onError = vi.fn();

    await streamAgentResponse('hi', 'S'.repeat(33), { onError });

    expect(onError).toHaveBeenCalledWith(expect.any(StreamDisconnectedError));
  });

  it('reports an HTTP error as it is', async () => {
    vi.mocked(agentClient.invoke).mockResolvedValue(new Response('{}', { status: 500 }));
    const onError = vi.fn();

    await streamAgentResponse('hi', 'S'.repeat(33), { onError });

    expect(onError.mock.calls[0][0]).not.toBeInstanceOf(StreamDisconnectedError);
  });
});

describe('streamAgentResponse error events', () => {
  it('passes the code and detail of a serverErrorEvent to onError', async () => {
    const { ServerStreamError } = await import('../../utils/server-stream-error');
    vi.mocked(agentClient.invoke).mockResolvedValue(
      ndjsonResponse([
        {
          type: 'serverErrorEvent',
          error: {
            message: 'limit',
            requestId: 'r',
            code: 'tokenLimitExceeded',
            modelKey: 'anthropic.claude-opus-5-5',
            dimension: 'output',
            used: 500_000,
            limit: 500_000,
            resetsAt: '2026-11-30T15:00:00Z',
          },
        },
      ])
    );
    const onError = vi.fn();

    await streamAgentResponse('hi', 'S'.repeat(33), { onError });

    const error = onError.mock.calls[0]![0];
    expect(error).toBeInstanceOf(ServerStreamError);
    expect(error.message).toBe('limit');
    expect(error.code).toBe('tokenLimitExceeded');
    expect(error.detail).toMatchObject({ modelKey: 'anthropic.claude-opus-5-5', limit: 500_000 });
  });
});
