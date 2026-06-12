/**
 * Document (browser tab) title sync hook
 *
 * Keeps `document.title` in sync with the active session: when a past
 * session is selected, the tab shows that session's title instead of the
 * static app name. Falls back to {@link APP_TITLE} when no session is
 * active, the session list has not loaded yet, or a session has no title.
 *
 * Subscribing to the `sessions` array (not just `activeSessionId`) means
 * the tab title automatically follows late title updates — e.g. the
 * auto-naming that runs after the first streamed response
 * (`updateSessionTitle`).
 */

import { useEffect } from 'react';
import { useSessionStore } from '../stores/sessionStore';

/**
 * Default browser tab title. Mirrors the static `<title>` in `index.html`,
 * which still covers the initial load and unselected states.
 */
export const APP_TITLE = 'Multi-agent Orchestration Chat';

export function useDocumentTitle(): void {
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const sessions = useSessionStore((state) => state.sessions);

  useEffect(() => {
    const activeSession = activeSessionId
      ? sessions.find((session) => session.sessionId === activeSessionId)
      : undefined;

    document.title = activeSession?.title?.trim()
      ? activeSession.title
      : APP_TITLE;

    return () => {
      document.title = APP_TITLE;
    };
  }, [activeSessionId, sessions]);
}
