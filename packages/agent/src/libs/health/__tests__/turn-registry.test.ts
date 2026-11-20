/**
 * One in-flight turn per session (AC-5), and busy reporting that survives a
 * client disconnect.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  tryBeginTurn,
  endTurn,
  getActiveTurn,
  makeTurnCancellable,
  resetTurnRegistry,
  stopTurn,
} from '../turn-registry.js';
import { isBusy, resetInFlight } from '../in-flight.js';

beforeEach(() => {
  resetTurnRegistry();
  resetInFlight();
});

describe('turn registry', () => {
  it('admits only one turn per session at a time', () => {
    expect(tryBeginTurn('s1', 'r1')).toBe(true);
    expect(tryBeginTurn('s1', 'r2')).toBe(false);
    expect(tryBeginTurn('s2', 'r3')).toBe(true);
    expect(getActiveTurn('s1')).toMatchObject({ requestId: 'r1' });
  });

  it('only the owning request can end a turn', () => {
    tryBeginTurn('s1', 'r1');
    endTurn('s1', 'r2');
    expect(getActiveTurn('s1')).toBeDefined();
    endTurn('s1', 'r1');
    expect(getActiveTurn('s1')).toBeUndefined();
    expect(tryBeginTurn('s1', 'r3')).toBe(true);
  });

  it('keeps the container busy while a turn runs after its client disconnected', () => {
    // trackInFlight releases on response close (client abort); the turn keeps
    // running server-side and must still report HealthyBusy on /ping.
    tryBeginTurn('s1', 'r1');
    expect(isBusy()).toBe(true);
    endTurn('s1', 'r1');
    expect(isBusy()).toBe(false);
  });

  describe('stopTurn', () => {
    it('aborts the signal of a cancellable turn for its owner', () => {
      tryBeginTurn('s1', 'r1', 'user-a');
      const signal = makeTurnCancellable('s1', 'r1');
      expect(stopTurn('s1', 'user-a')).toBe(true);
      expect(signal?.aborted).toBe(true);
    });

    it('refuses a stop from another user', () => {
      tryBeginTurn('s1', 'r1', 'user-a');
      const signal = makeTurnCancellable('s1', 'r1');
      expect(stopTurn('s1', 'user-b')).toBe(false);
      expect(signal?.aborted).toBe(false);
    });

    it('does not stop a turn that never opted in (workflow steps)', () => {
      tryBeginTurn('s1', 'r1', 'user-a');
      expect(stopTurn('s1', 'user-a')).toBe(false);
    });

    it('does not stop a turn without a recorded owner', () => {
      tryBeginTurn('s1', 'r1');
      makeTurnCancellable('s1', 'r1');
      expect(stopTurn('s1', 'user-a')).toBe(false);
    });

    it('is a no-op once the turn has ended', () => {
      tryBeginTurn('s1', 'r1', 'user-a');
      makeTurnCancellable('s1', 'r1');
      endTurn('s1', 'r1');
      expect(stopTurn('s1', 'user-a')).toBe(false);
    });

    it('only the owning request gets a signal', () => {
      tryBeginTurn('s1', 'r1', 'user-a');
      expect(makeTurnCancellable('s1', 'r2')).toBeUndefined();
    });
  });
});
