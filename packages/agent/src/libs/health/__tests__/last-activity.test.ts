/**
 * `time_of_last_update` must only move when the busy state changes. If it
 * tracked the poll time, the platform would always see idle ≈ 0 and never
 * reclaim the microVM before `maxLifetime`.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getTimeOfLastUpdate, resetLastActivity } from '../last-activity.js';
import { beginInvocation, endInvocation, resetInFlight } from '../in-flight.js';
import { endTurn, resetTurnRegistry, tryBeginTurn } from '../turn-registry.js';

const T0 = new Date('2026-11-10T00:00:00Z').getTime();
const sec = (ms: number) => Math.floor(ms / 1000);
const at = (minutes: number) => jest.setSystemTime(T0 + minutes * 60_000);

describe('last activity timestamp', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
    resetInFlight();
    resetTurnRegistry();
    resetLastActivity();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not advance with wall-clock time alone', () => {
    at(30);
    expect(getTimeOfLastUpdate()).toBe(sec(T0));
  });

  it('is stamped when an invocation begins and ends', () => {
    at(1);
    beginInvocation();
    expect(getTimeOfLastUpdate()).toBe(sec(T0 + 60_000));

    at(4);
    endInvocation();
    at(20);
    expect(getTimeOfLastUpdate()).toBe(sec(T0 + 4 * 60_000));
  });

  it('is stamped when a turn that outlived its response ends', () => {
    tryBeginTurn('s1', 'r1');
    at(2);
    endTurn('s1', 'r1');
    expect(getTimeOfLastUpdate()).toBe(sec(T0 + 2 * 60_000));
  });

  it('ignores rejected turns and non-owner endTurn calls', () => {
    tryBeginTurn('s1', 'r1');
    at(5);
    expect(tryBeginTurn('s1', 'r2')).toBe(false);
    endTurn('s1', 'r2');
    expect(getTimeOfLastUpdate()).toBe(sec(T0));
  });
});
