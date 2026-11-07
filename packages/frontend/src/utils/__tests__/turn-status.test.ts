/**
 * Whether a session's turn is still running server-side (AC-6), from the
 * marker the agent writes on the session row. A marker whose session has not
 * been touched for longer than the microVM idle timeout is stale (the
 * runtime died before it could clear it) and must not lock the UI.
 */

import { describe, it, expect } from 'vitest';
import { isTurnRunning, TURN_STALE_AFTER_MS } from '../turn-status';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('isTurnRunning', () => {
  it('is false without a marker', () => {
    expect(isTurnRunning({ updatedAt: iso(0) }, NOW)).toBe(false);
    expect(isTurnRunning(undefined, NOW)).toBe(false);
  });

  it('is true for a marker on a recently updated session, however long the turn has run', () => {
    expect(
      isTurnRunning({ activeTurnStartedAt: iso(3 * 3600_000), updatedAt: iso(60_000) }, NOW)
    ).toBe(true);
  });

  it('treats a marker as stale once the session has been idle past the threshold', () => {
    expect(
      isTurnRunning(
        {
          activeTurnStartedAt: iso(TURN_STALE_AFTER_MS * 2),
          updatedAt: iso(TURN_STALE_AFTER_MS + 1),
        },
        NOW
      )
    ).toBe(false);
  });

  it('ignores a marker for a turn this tab already finished streaming (clear event still in flight)', () => {
    const session = { activeTurnStartedAt: iso(120_000), updatedAt: iso(1_000) };
    expect(isTurnRunning(session, NOW, NOW - 500)).toBe(false);
    // A newer turn (started after our stream completed) still counts.
    expect(isTurnRunning(session, NOW, NOW - 600_000)).toBe(true);
  });
});
