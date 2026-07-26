/**
 * settingsStore — persistent (sticky) goal.
 *
 * The sticky goal is a client-side convenience: it is persisted to
 * localStorage and re-attached by MessageInput on every send; the wire
 * contract stays per-message. These tests cover set/clear semantics and the
 * whitespace-only guard (an empty sticky goal would silently no-op on the
 * agent side, so it must collapse to "no sticky goal").
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from '../settingsStore';

describe('settingsStore persistentGoal', () => {
  beforeEach(() => {
    useSettingsStore.setState({ persistentGoal: null });
  });

  it('stores a trimmed sticky goal with its judge model', () => {
    useSettingsStore.getState().setPersistentGoal({
      text: '  3文以内で答える  ',
      judgeModelId: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    });

    expect(useSettingsStore.getState().persistentGoal).toEqual({
      text: '3文以内で答える',
      judgeModelId: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    });
  });

  it('treats a whitespace-only goal as clear', () => {
    useSettingsStore.getState().setPersistentGoal({ text: 'valid goal' });
    useSettingsStore.getState().setPersistentGoal({ text: '   ' });

    expect(useSettingsStore.getState().persistentGoal).toBeNull();
  });

  it('clearPersistentGoal removes the sticky goal', () => {
    useSettingsStore.getState().setPersistentGoal({ text: 'valid goal' });
    useSettingsStore.getState().clearPersistentGoal();

    expect(useSettingsStore.getState().persistentGoal).toBeNull();
  });

  it('keeps judgeModelId undefined when not supplied (server default)', () => {
    useSettingsStore.getState().setPersistentGoal({ text: 'goal' });

    expect(useSettingsStore.getState().persistentGoal).toEqual({
      text: 'goal',
      judgeModelId: undefined,
      maxAttempts: undefined,
    });
  });

  it('stores maxAttempts with the sticky goal', () => {
    useSettingsStore.getState().setPersistentGoal({ text: 'goal', maxAttempts: 5 });

    expect(useSettingsStore.getState().persistentGoal?.maxAttempts).toBe(5);
  });
});
