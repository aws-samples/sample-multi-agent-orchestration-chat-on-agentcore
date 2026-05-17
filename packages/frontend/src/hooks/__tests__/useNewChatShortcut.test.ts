import { describe, it, expect } from 'vitest';
import { shouldTriggerNewChatShortcut } from '../useNewChatShortcut';

type KeyEventLike = Parameters<typeof shouldTriggerNewChatShortcut>[0];

const keyEvent = (overrides: Partial<KeyEventLike>): KeyEventLike => ({
  key: 'o',
  metaKey: false,
  ctrlKey: false,
  shiftKey: true,
  altKey: false,
  ...overrides,
});

describe('shouldTriggerNewChatShortcut', () => {
  describe('on macOS', () => {
    const isMac = true;

    it('returns true for Cmd+Shift+O', () => {
      expect(shouldTriggerNewChatShortcut(keyEvent({ metaKey: true }), isMac)).toBe(true);
    });

    it('returns true for Cmd+Shift+O with uppercase key (caps lock)', () => {
      expect(shouldTriggerNewChatShortcut(keyEvent({ key: 'O', metaKey: true }), isMac)).toBe(true);
    });

    it('returns false for Cmd+O without Shift (reserved for "open file")', () => {
      expect(
        shouldTriggerNewChatShortcut(keyEvent({ metaKey: true, shiftKey: false }), isMac)
      ).toBe(false);
    });

    it('returns false for Ctrl+Shift+O on macOS', () => {
      expect(shouldTriggerNewChatShortcut(keyEvent({ ctrlKey: true }), isMac)).toBe(false);
    });

    it('returns false when both Cmd and Ctrl are pressed', () => {
      expect(shouldTriggerNewChatShortcut(keyEvent({ metaKey: true, ctrlKey: true }), isMac)).toBe(
        false
      );
    });

    it('returns false for Cmd+Shift+Alt+O', () => {
      expect(shouldTriggerNewChatShortcut(keyEvent({ metaKey: true, altKey: true }), isMac)).toBe(
        false
      );
    });

    it('returns false for bare Shift+O without Cmd', () => {
      expect(shouldTriggerNewChatShortcut(keyEvent({}), isMac)).toBe(false);
    });

    it('returns false for non-O keys with Cmd+Shift', () => {
      expect(shouldTriggerNewChatShortcut(keyEvent({ key: 'k', metaKey: true }), isMac)).toBe(
        false
      );
    });
  });

  describe('on Windows/Linux', () => {
    const isMac = false;

    it('returns true for Ctrl+Shift+O', () => {
      expect(shouldTriggerNewChatShortcut(keyEvent({ ctrlKey: true }), isMac)).toBe(true);
    });

    it('returns false for Cmd+Shift+O on non-Mac (Meta key alone should not trigger)', () => {
      expect(shouldTriggerNewChatShortcut(keyEvent({ metaKey: true }), isMac)).toBe(false);
    });

    it('returns false for Ctrl+O without Shift', () => {
      expect(
        shouldTriggerNewChatShortcut(keyEvent({ ctrlKey: true, shiftKey: false }), isMac)
      ).toBe(false);
    });

    it('returns false for Ctrl+Shift+Alt+O', () => {
      expect(shouldTriggerNewChatShortcut(keyEvent({ ctrlKey: true, altKey: true }), isMac)).toBe(
        false
      );
    });

    it('returns false when both Ctrl and Meta are pressed', () => {
      expect(shouldTriggerNewChatShortcut(keyEvent({ ctrlKey: true, metaKey: true }), isMac)).toBe(
        false
      );
    });

    it('returns false for bare Shift+O without Ctrl', () => {
      expect(shouldTriggerNewChatShortcut(keyEvent({}), isMac)).toBe(false);
    });
  });
});
