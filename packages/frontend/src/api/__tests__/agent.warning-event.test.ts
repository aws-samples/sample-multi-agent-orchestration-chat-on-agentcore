/**
 * The runtime reports "this turn is no longer being saved" as an
 * out-of-band serverWarningEvent (AC-3); it must reach the caller.
 */

import { describe, it, expect, vi } from 'vitest';
import { agentClient } from '../client/agent-client';
import { streamAgentResponse } from '../agent';
import { StreamStalledError, STREAM_IDLE_TIMEOUT_MS } from '../../utils/stream-idle-watchdog';

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
