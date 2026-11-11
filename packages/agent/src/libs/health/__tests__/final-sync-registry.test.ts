/**
 * Unit tests for final-sync-registry
 *
 * Verifies that beginFinalSync / endFinalSync correctly drive hasPendingFinalSyncs(),
 * and that isBusy() (via in-flight.ts) returns true while a final sync is active.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  beginFinalSync,
  endFinalSync,
  hasPendingFinalSyncs,
  resetFinalSyncRegistry,
} from '../final-sync-registry.js';

describe('final-sync-registry', () => {
  beforeEach(() => {
    resetFinalSyncRegistry();
  });

  it('starts with no pending syncs', () => {
    expect(hasPendingFinalSyncs()).toBe(false);
  });

  it('reports pending after beginFinalSync', () => {
    beginFinalSync();
    expect(hasPendingFinalSyncs()).toBe(true);
  });

  it('clears after a matching endFinalSync', () => {
    beginFinalSync();
    endFinalSync();
    expect(hasPendingFinalSyncs()).toBe(false);
  });

  it('supports concurrent syncs: still pending after partial end', () => {
    beginFinalSync();
    beginFinalSync();
    endFinalSync();
    expect(hasPendingFinalSyncs()).toBe(true);
    endFinalSync();
    expect(hasPendingFinalSyncs()).toBe(false);
  });

  it('endFinalSync is clamped at zero (unbalanced call does not go negative)', () => {
    endFinalSync(); // counter was already 0
    expect(hasPendingFinalSyncs()).toBe(false);
  });
});

describe('isBusy() includes final-sync state', () => {
  beforeEach(() => {
    resetFinalSyncRegistry();
  });

  it('isBusy() returns true while a final sync is pending', async () => {
    // Import dynamically so the mock registry (reset above) is used
    const { isBusy, resetInFlight } = await import('../in-flight.js');
    const { resetTurnRegistry } = await import('../turn-registry.js');
    resetInFlight();
    resetTurnRegistry();

    expect(isBusy()).toBe(false);

    beginFinalSync();
    expect(isBusy()).toBe(true);

    endFinalSync();
    expect(isBusy()).toBe(false);
  });
});
