/**
 * Unit tests for the agent cancel registry.
 *
 * Backs the out-of-band stop path: a `{ action: 'stop' }` invocation arriving
 * on the SAME microVM (session-sticky routing) looks up the in-flight Agent by
 * sessionId and calls `agent.cancel()`. See libs/health/agent-cancel-registry.ts.
 *
 * A process-global map is the right scope: AgentCore pins one session to one
 * microVM (one process), so the running turn and its stop command share this
 * module singleton — the same reasoning as in-flight.ts.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  registerAgent,
  unregisterAgent,
  cancelAgent,
  isRegistered,
  resetRegistry,
} from '../agent-cancel-registry.js';

/** Minimal Agent stand-in — the registry only ever calls `.cancel()`. */
function fakeAgent() {
  return { cancel: jest.fn() } as any;
}

describe('agent cancel registry', () => {
  beforeEach(() => {
    resetRegistry();
  });

  it('starts empty', () => {
    expect(isRegistered('s1')).toBe(false);
  });

  it('registers an agent under its sessionId', () => {
    registerAgent('s1', fakeAgent());
    expect(isRegistered('s1')).toBe(true);
  });

  it('cancelAgent calls cancel() on the registered agent and returns true', () => {
    const agent = fakeAgent();
    registerAgent('s1', agent);

    const result = cancelAgent('s1');

    expect(result).toBe(true);
    expect(agent.cancel).toHaveBeenCalledTimes(1);
  });

  it('cancelAgent returns false and is a no-op for an unknown session', () => {
    expect(cancelAgent('nope')).toBe(false);
  });

  it('unregisterAgent removes the entry so a later cancel is a no-op', () => {
    const agent = fakeAgent();
    registerAgent('s1', agent);
    unregisterAgent('s1');

    expect(isRegistered('s1')).toBe(false);
    expect(cancelAgent('s1')).toBe(false);
    expect(agent.cancel).not.toHaveBeenCalled();
  });

  it('unregister only removes the matching agent (guards against a stale later turn evicting the current one)', () => {
    const first = fakeAgent();
    registerAgent('s1', first);
    // A new turn for the same session replaces the registration.
    const second = fakeAgent();
    registerAgent('s1', second);

    // The first turn finishing must NOT unregister the second turn's agent.
    unregisterAgent('s1', first);
    expect(isRegistered('s1')).toBe(true);

    cancelAgent('s1');
    expect(second.cancel).toHaveBeenCalledTimes(1);
    expect(first.cancel).not.toHaveBeenCalled();
  });

  it('keeps registrations for different sessions independent', () => {
    const a = fakeAgent();
    const b = fakeAgent();
    registerAgent('s1', a);
    registerAgent('s2', b);

    cancelAgent('s1');
    expect(a.cancel).toHaveBeenCalledTimes(1);
    expect(b.cancel).not.toHaveBeenCalled();
  });
});
