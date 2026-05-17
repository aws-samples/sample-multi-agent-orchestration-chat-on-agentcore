/**
 * New chat keyboard shortcut hook
 *
 * Registers a global Cmd+Shift+O (macOS) / Ctrl+Shift+O (Windows, Linux)
 * shortcut that starts a new chat by clearing the active session and
 * navigating to the chat entry route.
 *
 * Matches ChatGPT's convention for "new chat" (`Cmd/Ctrl + Shift + O`)
 * so existing users can rely on muscle memory.
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../stores/sessionStore';

/**
 * Returns true when the given keyboard event should trigger the
 * new chat shortcut. Exported for unit testing.
 *
 * Rules:
 * - Key must be "o" (case-insensitive)
 * - Shift must be pressed (to avoid collision with macOS/browser bindings
 *   such as `Cmd+O` "open file")
 * - Alt must not be pressed
 * - On Mac: Cmd only (metaKey && !ctrlKey)
 * - Non-Mac: Ctrl only (ctrlKey && !metaKey)
 */
export const shouldTriggerNewChatShortcut = (
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  isMac: boolean
): boolean => {
  if (event.key.toLowerCase() !== 'o') return false;
  if (!event.shiftKey) return false;
  if (event.altKey) return false;

  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
};

const isMacPlatform = (): boolean => navigator.platform.toUpperCase().indexOf('MAC') >= 0;

/**
 * Registers the Cmd+Shift+O / Ctrl+Shift+O new chat shortcut.
 *
 * Should be mounted once from a top-level layout component
 * (e.g. MainLayout) to avoid duplicate listener registration.
 */
export const useNewChatShortcut = (): void => {
  const navigate = useNavigate();
  const clearActiveSession = useSessionStore((state) => state.clearActiveSession);

  useEffect(() => {
    const isMac = isMacPlatform();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!shouldTriggerNewChatShortcut(event, isMac)) return;
      event.preventDefault();
      clearActiveSession();
      navigate('/chat');
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [navigate, clearActiveSession]);
};
