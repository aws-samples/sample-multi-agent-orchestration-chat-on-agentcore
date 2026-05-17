import { describe, it, expect } from 'vitest';
import { shouldToggleShortcutsHelp } from '../useShortcutsHelp';

type KeyEventLike = Parameters<typeof shouldToggleShortcutsHelp>[0];

const keyEvent = (overrides: Partial<KeyEventLike>): KeyEventLike => ({
  key: '/',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...overrides,
});

describe('shouldToggleShortcutsHelp', () => {
  describe('on macOS', () => {
    const isMac = true;

    it('returns true for Cmd+/', () => {
      expect(shouldToggleShortcutsHelp(keyEvent({ metaKey: true }), isMac)).toBe(true);
    });

    it('returns true for Cmd+? (Shift+/ on US layout)', () => {
      expect(shouldToggleShortcutsHelp(keyEvent({ key: '?', metaKey: true }), isMac)).toBe(true);
    });

    it('returns false for bare / without modifiers', () => {
      expect(shouldToggleShortcutsHelp(keyEvent({}), isMac)).toBe(false);
    });

    it('returns false for Ctrl+/ on macOS', () => {
      expect(shouldToggleShortcutsHelp(keyEvent({ ctrlKey: true }), isMac)).toBe(false);
    });

    it('returns false when both Cmd and Ctrl are pressed', () => {
      expect(shouldToggleShortcutsHelp(keyEvent({ metaKey: true, ctrlKey: true }), isMac)).toBe(
        false
      );
    });

    it('returns false for Cmd+Alt+/', () => {
      expect(shouldToggleShortcutsHelp(keyEvent({ metaKey: true, altKey: true }), isMac)).toBe(
        false
      );
    });

    it('returns false for non-slash keys with Cmd', () => {
      expect(shouldToggleShortcutsHelp(keyEvent({ key: 'k', metaKey: true }), isMac)).toBe(false);
    });
  });

  describe('on Windows/Linux', () => {
    const isMac = false;

    it('returns true for Ctrl+/', () => {
      expect(shouldToggleShortcutsHelp(keyEvent({ ctrlKey: true }), isMac)).toBe(true);
    });

    it('returns true for Ctrl+?', () => {
      expect(shouldToggleShortcutsHelp(keyEvent({ key: '?', ctrlKey: true }), isMac)).toBe(true);
    });

    it('returns false for Cmd+/ on non-Mac (Meta key alone should not trigger)', () => {
      expect(shouldToggleShortcutsHelp(keyEvent({ metaKey: true }), isMac)).toBe(false);
    });

    it('returns false for Ctrl+Alt+/', () => {
      expect(shouldToggleShortcutsHelp(keyEvent({ ctrlKey: true, altKey: true }), isMac)).toBe(
        false
      );
    });

    it('returns false when both Ctrl and Meta are pressed', () => {
      expect(shouldToggleShortcutsHelp(keyEvent({ ctrlKey: true, metaKey: true }), isMac)).toBe(
        false
      );
    });

    it('returns false for bare / without modifiers', () => {
      expect(shouldToggleShortcutsHelp(keyEvent({}), isMac)).toBe(false);
    });
  });
});
