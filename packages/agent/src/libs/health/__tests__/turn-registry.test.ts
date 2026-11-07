/**
 * One in-flight turn per session (AC-5), and busy reporting that survives a
 * client disconnect.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { tryBeginTurn, endTurn, getActiveTurn, resetTurnRegistry } from '../turn-registry.js';
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
});
