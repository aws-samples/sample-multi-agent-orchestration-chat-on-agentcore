import { describe, it, expect } from 'vitest';
import { shouldToggleSidebarShortcut } from '../useSidebarShortcut';

type KeyEventLike = Parameters<typeof shouldToggleSidebarShortcut>[0];

const keyEvent = (overrides: Partial<KeyEventLike>): KeyEventLike => ({
  key: 'b',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

describe('shouldToggleSidebarShortcut', () => {
  describe('on macOS', () => {
    const isMac = true;

    it('returns true for Cmd+B', () => {
      expect(shouldToggleSidebarShortcut(keyEvent({ metaKey: true }), isMac)).toBe(true);
    });

    it('returns true for Cmd+B with uppercase key (caps lock)', () => {
      expect(shouldToggleSidebarShortcut(keyEvent({ key: 'B', metaKey: true }), isMac)).toBe(true);
    });

    it('returns false for Ctrl+B on macOS', () => {
      expect(shouldToggleSidebarShortcut(keyEvent({ ctrlKey: true }), isMac)).toBe(false);
    });

    it('returns false when both Cmd and Ctrl are pressed', () => {
      expect(shouldToggleSidebarShortcut(keyEvent({ metaKey: true, ctrlKey: true }), isMac)).toBe(
        false
      );
    });

    it('returns false for Cmd+Shift+B', () => {
      expect(shouldToggleSidebarShortcut(keyEvent({ metaKey: true, shiftKey: true }), isMac)).toBe(
        false
      );
    });

    it('returns false for Cmd+Alt+B', () => {
      expect(shouldToggleSidebarShortcut(keyEvent({ metaKey: true, altKey: true }), isMac)).toBe(
        false
      );
    });

    it('returns false for bare B without modifiers', () => {
      expect(shouldToggleSidebarShortcut(keyEvent({}), isMac)).toBe(false);
    });

    it('returns false for non-B keys with Cmd', () => {
      expect(shouldToggleSidebarShortcut(keyEvent({ key: 'k', metaKey: true }), isMac)).toBe(false);
    });
  });

  describe('on Windows/Linux', () => {
    const isMac = false;

    it('returns true for Ctrl+B', () => {
      expect(shouldToggleSidebarShortcut(keyEvent({ ctrlKey: true }), isMac)).toBe(true);
    });

    it('returns false for Cmd+B on non-Mac (Meta key alone should not trigger)', () => {
      expect(shouldToggleSidebarShortcut(keyEvent({ metaKey: true }), isMac)).toBe(false);
    });

    it('returns false for Ctrl+Shift+B', () => {
      expect(shouldToggleSidebarShortcut(keyEvent({ ctrlKey: true, shiftKey: true }), isMac)).toBe(
        false
      );
    });

    it('returns false for Ctrl+Alt+B', () => {
      expect(shouldToggleSidebarShortcut(keyEvent({ ctrlKey: true, altKey: true }), isMac)).toBe(
        false
      );
    });

    it('returns false when both Ctrl and Meta are pressed', () => {
      expect(shouldToggleSidebarShortcut(keyEvent({ ctrlKey: true, metaKey: true }), isMac)).toBe(
        false
      );
    });

    it('returns false for bare B without modifiers', () => {
      expect(shouldToggleSidebarShortcut(keyEvent({}), isMac)).toBe(false);
    });
  });
});
