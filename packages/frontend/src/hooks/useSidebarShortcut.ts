/**
 * Sidebar toggle keyboard shortcut hook
 *
 * Registers a global Cmd+B (macOS) / Ctrl+B (Windows, Linux) shortcut
 * that toggles the sidebar open/close state.
 *
 * Disabled on mobile view where the sidebar is an overlay controlled
 * by the hamburger button / swipe gestures.
 */

import { useEffect } from 'react';
import { useUIStore } from '../stores/uiStore';

/**
 * Returns true when the given keyboard event should trigger the
 * sidebar toggle shortcut. Exported for unit testing.
 *
 * Rules:
 * - Key must be "b" (case-insensitive)
 * - On Mac: Cmd only (metaKey && !ctrlKey)
 * - Non-Mac: Ctrl only (ctrlKey && !metaKey)
 * - Shift/Alt modifiers must not be pressed (avoid collisions with
 *   browser shortcuts such as Cmd+Shift+B / Ctrl+Alt+B)
 */
export const shouldToggleSidebarShortcut = (
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  isMac: boolean
): boolean => {
  if (event.key.toLowerCase() !== 'b') return false;
  if (event.shiftKey || event.altKey) return false;

  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
};

const isMacPlatform = (): boolean => navigator.platform.toUpperCase().indexOf('MAC') >= 0;

/**
 * Registers the Cmd+B / Ctrl+B sidebar toggle shortcut.
 *
 * Should be mounted once from a top-level layout component
 * (e.g. MainLayout) to avoid duplicate listener registration.
 */
export const useSidebarShortcut = (): void => {
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const isMobileView = useUIStore((state) => state.isMobileView);

  useEffect(() => {
    // Shortcut is intentionally disabled on mobile. The sidebar is
    // overlay-style and driven by the hamburger button / swipe gestures.
    if (isMobileView) return;

    const isMac = isMacPlatform();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!shouldToggleSidebarShortcut(event, isMac)) return;
      event.preventDefault();
      toggleSidebar();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [toggleSidebar, isMobileView]);
};
