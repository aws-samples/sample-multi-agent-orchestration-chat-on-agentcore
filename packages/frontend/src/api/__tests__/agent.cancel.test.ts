/**
 * Unit tests for streamAgentResponse cancellation wiring.
 *
 * Guards two behaviours needed for the Stop button:
 *   - the caller's AbortSignal is forwarded to agentClient.invoke, so aborting
 *     it tears down the underlying fetch;
 *   - an aborted read (fetch throws AbortError, or the server closes the stream)
 *     is treated as a graceful stop via onCancel — NOT surfaced as onError, so
 *     the UI doesn't render a spurious "An error occurred" bubble.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();

vi.mock('../client/agent-client', () => ({
  agentClient: { invoke: (opts: RequestInit) => invoke(opts) },
}));
vi.mock('../../utils/logger', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { streamAgentResponse, stopAgentTurn } from '../agent';

/** Build a Response whose body streams the given NDJSON lines then closes. */
function ndjsonResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + '\n'));
      controller.close();
    },
  });
  return { ok: true, body: stream } as unknown as Response;
}

/** Build a Response whose body errors with an AbortError mid-read. */
function abortingResponse(): Response {
  const stream = new ReadableStream({
    start(controller) {
      const err = new DOMException('The user aborted a request.', 'AbortError');
      controller.error(err);
    },
  });
  return { ok: true, body: stream } as unknown as Response;
}

describe('streamAgentResponse cancellation', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('forwards the AbortSignal to agentClient.invoke', async () => {
    invoke.mockResolvedValue(ndjsonResponse([]));
    const controller = new AbortController();

    await streamAgentResponse('hi', 'session-1', {}, undefined, controller.signal);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0].signal).toBe(controller.signal);
  });

  it('calls onCancel (not onError) when the read is aborted', async () => {
    invoke.mockResolvedValue(abortingResponse());
    const onError = vi.fn();
    const onCancel = vi.fn();

    await streamAgentResponse('hi', 'session-1', { onError, onCancel });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('treats a serverCancelledEvent as a graceful stop via onCancel', async () => {
    invoke.mockResolvedValue(
      ndjsonResponse([JSON.stringify({ type: 'serverCancelledEvent', metadata: {} })])
    );
    const onError = vi.fn();
    const onCancel = vi.fn();
    const onComplete = vi.fn();

    await streamAgentResponse('hi', 'session-1', { onError, onCancel, onComplete });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe('stopAgentTurn', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('posts { action: stop } with the same session id header', async () => {
    invoke.mockResolvedValue({ ok: true } as Response);

    const ok = await stopAgentTurn('session-1');

    expect(ok).toBe(true);
    const opts = invoke.mock.calls[0][0];
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ action: 'stop' });
    expect(opts.headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']).toBe('session-1');
  });

  it('returns false (never throws) when the request fails', async () => {
    invoke.mockRejectedValue(new Error('network down'));

    await expect(stopAgentTurn('session-1')).resolves.toBe(false);
  });

  it('returns false on a non-ok response', async () => {
    invoke.mockResolvedValue({ ok: false } as Response);

    await expect(stopAgentTurn('session-1')).resolves.toBe(false);
  });
});
