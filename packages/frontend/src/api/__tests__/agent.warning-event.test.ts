/**
 * The runtime reports "this turn is no longer being saved" as an
 * out-of-band serverWarningEvent (AC-3); it must reach the caller.
 */

import { describe, it, expect, vi } from 'vitest';
import { agentClient } from '../client/agent-client';
import { streamAgentResponse } from '../agent';

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
