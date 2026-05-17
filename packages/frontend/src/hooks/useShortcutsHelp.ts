/**
 * Keyboard shortcuts help modal hook
 *
 * Registers a global Cmd+/ (macOS) / Ctrl+/ (Windows, Linux) shortcut
 * that opens the shortcuts help modal. Matches ChatGPT's convention.
 */

import { useCallback, useEffect, useState } from 'react';

/**
 * Returns true when the given keyboard event should toggle the shortcuts
 * help modal. Exported for unit testing.
 *
 * Rules:
 * - Key must be "/" (slash). Also accepts "?" to tolerate keyboard layouts
 *   where Shift+/ is required to produce "/" but the event still reports
 *   "?" (e.g. certain JIS layouts).
 * - Alt must not be pressed.
 * - On Mac: Cmd only (metaKey && !ctrlKey).
 * - Non-Mac: Ctrl only (ctrlKey && !metaKey).
 */
export const shouldToggleShortcutsHelp = (
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>,
  isMac: boolean
): boolean => {
  if (event.key !== '/' && event.key !== '?') return false;
  if (event.altKey) return false;

  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
};

const isMacPlatform = (): boolean => navigator.platform.toUpperCase().indexOf('MAC') >= 0;

export type ShortcutsHelpState = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
};

/**
 * Registers the Cmd+/ / Ctrl+/ shortcut and returns open/close state
 * for the shortcuts help modal.
 */
export const useShortcutsHelp = (): ShortcutsHelpState => {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    const isMac = isMacPlatform();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!shouldToggleShortcutsHelp(event, isMac)) return;
      event.preventDefault();
      setIsOpen((prev) => !prev);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return { isOpen, open, close };
};
