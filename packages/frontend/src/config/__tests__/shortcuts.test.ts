import { describe, it, expect } from 'vitest';
import { SHORTCUT_GROUPS, formatShortcut } from '../shortcuts';

describe('formatShortcut', () => {
  describe('on macOS', () => {
    const isMac = true;

    it('formats Cmd+K as ["⌘", "K"]', () => {
      expect(formatShortcut({ mod: true, key: 'K' }, isMac)).toEqual(['⌘', 'K']);
    });

    it('formats Cmd+Shift+O as ["⇧", "⌘", "O"]', () => {
      expect(formatShortcut({ mod: true, shift: true, key: 'O' }, isMac)).toEqual(['⇧', '⌘', 'O']);
    });

    it('formats Cmd+Alt+Shift+X as ["⌥", "⇧", "⌘", "X"]', () => {
      expect(formatShortcut({ mod: true, alt: true, shift: true, key: 'X' }, isMac)).toEqual([
        '⌥',
        '⇧',
        '⌘',
        'X',
      ]);
    });

    it('formats bare Enter as ["Enter"]', () => {
      expect(formatShortcut({ key: 'Enter' }, isMac)).toEqual(['Enter']);
    });
  });

  describe('on Windows/Linux', () => {
    const isMac = false;

    it('formats Ctrl+K as ["Ctrl", "K"]', () => {
      expect(formatShortcut({ mod: true, key: 'K' }, isMac)).toEqual(['Ctrl', 'K']);
    });

    it('formats Ctrl+Shift+O as ["Shift", "Ctrl", "O"]', () => {
      expect(formatShortcut({ mod: true, shift: true, key: 'O' }, isMac)).toEqual([
        'Shift',
        'Ctrl',
        'O',
      ]);
    });

    it('formats Ctrl+/ as ["Ctrl", "/"]', () => {
      expect(formatShortcut({ mod: true, key: '/' }, isMac)).toEqual(['Ctrl', '/']);
    });
  });
});

describe('SHORTCUT_GROUPS', () => {
  it('contains at least one group', () => {
    expect(SHORTCUT_GROUPS.length).toBeGreaterThan(0);
  });

  it('every item has an i18n label key and a non-empty main key', () => {
    for (const group of SHORTCUT_GROUPS) {
      expect(group.titleKey).toMatch(/^shortcuts\./);
      for (const item of group.items) {
        expect(item.labelKey).toMatch(/^shortcuts\./);
        expect(item.keys.key.length).toBeGreaterThan(0);
      }
    }
  });

  it('includes the "show shortcuts" item so this modal is self-documenting', () => {
    const allItems = SHORTCUT_GROUPS.flatMap((g) => g.items);
    const showShortcuts = allItems.find((i) => i.labelKey === 'shortcuts.items.showShortcuts');
    expect(showShortcuts).toBeDefined();
    expect(showShortcuts?.keys).toEqual({ mod: true, key: '/' });
  });
});
