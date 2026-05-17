/**
 * Keyboard shortcut catalog
 *
 * Single source of truth for the keyboard shortcuts exposed to the user.
 * Used by the ShortcutsModal (Cmd+/). Does NOT register the shortcuts —
 * each shortcut has its own hook (see hooks/useSidebarShortcut.ts etc.).
 */

export type ShortcutKeyCombo = {
  /** Primary modifier: Cmd on macOS, Ctrl on Windows/Linux. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** The non-modifier key label. Displayed verbatim (e.g. "O", "Enter", "/"). */
  key: string;
};

export type ShortcutItem = {
  /** i18n key for the action label. */
  labelKey: string;
  keys: ShortcutKeyCombo;
};

export type ShortcutGroup = {
  /** i18n key for the group heading. */
  titleKey: string;
  items: ShortcutItem[];
};

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    titleKey: 'shortcuts.groups.app',
    items: [
      {
        labelKey: 'shortcuts.items.toggleCommandPalette',
        keys: { mod: true, key: 'K' },
      },
      {
        labelKey: 'shortcuts.items.toggleSidebar',
        keys: { mod: true, key: 'B' },
      },
      {
        labelKey: 'shortcuts.items.newChat',
        keys: { mod: true, shift: true, key: 'O' },
      },
      {
        labelKey: 'shortcuts.items.showShortcuts',
        keys: { mod: true, key: '/' },
      },
    ],
  },
];

/**
 * Format a shortcut combination into an ordered array of display tokens.
 *
 * Mac output uses mac-native symbols: ⌃ (Ctrl), ⌥ (Alt), ⇧ (Shift), ⌘ (Cmd).
 * Non-Mac output uses ASCII names: "Ctrl", "Alt", "Shift".
 *
 * Modifier order mirrors macOS convention (Ctrl → Alt → Shift → Cmd → key)
 * so both platforms read in a consistent, predictable order.
 */
export const formatShortcut = (combo: ShortcutKeyCombo, isMac: boolean): string[] => {
  const tokens: string[] = [];

  if (combo.alt) tokens.push(isMac ? '⌥' : 'Alt');
  if (combo.shift) tokens.push(isMac ? '⇧' : 'Shift');
  if (combo.mod) tokens.push(isMac ? '⌘' : 'Ctrl');

  tokens.push(combo.key);
  return tokens;
};
