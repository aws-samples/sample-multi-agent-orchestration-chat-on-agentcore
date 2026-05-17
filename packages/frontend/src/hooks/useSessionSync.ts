/**
 * Session Sync Custom Hook
 *
 * Manages synchronization between URL parameters and sessionStore state.
 */

import { useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSessionStore } from '../stores/sessionStore';
import { useChatStore } from '../stores/chatStore';
import { logger } from '../utils/logger';

export interface UseSessionSyncReturn {
  currentSessionId: string | null;
  isNewChat: boolean;
  createAndNavigateToNewSession: () => string;
}

/**
 * Session Sync Hook
 *
 * Synchronizes URL sessionId with Store state and manages
 * navigation when creating new sessions.
 *
 * @returns {UseSessionSyncReturn} Session sync information and actions
 */
export function useSessionSync(): UseSessionSyncReturn {
  const { sessionId: urlSessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  /**
   * WHY: Track previous URL sessionId to detect actual URL changes
   *
   * React's useEffect with dependencies like urlSessionId can trigger multiple times
   * during a single navigation event due to React's render cycle. This causes a race condition:
   *
   * 1. User clicks "New Chat" which calls navigate('/chat')
   * 2. Before React Router updates the URL, useEffect fires with OLD urlSessionId
   * 3. switchSession(OLD_SESSION_ID) is incorrectly called
   * 4. URL finally updates to '/chat', useEffect fires again with urlSessionId = undefined
   * 5. clearActiveSession() is called, but damage is done - chatStore already switched to old session
   *
   * By tracking the previous urlSessionId, we can:
   * - Detect when URL has actually changed (prevRef !== current)
   * - Only trigger session switching when URL genuinely changes
   * - Prevent stale values from triggering incorrect state updates
   *
   * Using `undefined` as initial value to distinguish from:
   * - `null` which means explicitly no session
   * - `undefined` which means "not yet initialized"
   */
  const prevUrlSessionIdRef = useRef<string | undefined>(undefined);

  const {
    activeSessionId,
    sessionEvents,
    isCreatingSession,
    selectSession,
    clearActiveSession,
    createNewSession,
    finalizeNewSession,
  } = useSessionStore();

  const { switchSession, loadSessionHistory } = useChatStore();

  // URL → Store synchronization
  useEffect(() => {
    /**
     * WHY: Check if URL actually changed
     *
     * This comparison prevents the race condition described above.
     * We only process URL changes when prevUrlSessionIdRef differs from current urlSessionId.
     *
     * On first render (prevUrlSessionIdRef.current === undefined), we treat it as a change
     * to ensure initial synchronization works correctly.
     */
    const isInitialRender = prevUrlSessionIdRef.current === undefined;
    const urlActuallyChanged = prevUrlSessionIdRef.current !== urlSessionId;

    // Update the ref BEFORE processing to avoid infinite loops
    const previousUrlSessionId = prevUrlSessionIdRef.current;
    prevUrlSessionIdRef.current = urlSessionId;

    // During new session creation
    if (isCreatingSession) {
      // When urlSessionId matches activeSessionId, URL sync is complete
      if (urlSessionId && urlSessionId === activeSessionId) {
        logger.log('New session URL sync complete');
        finalizeNewSession();
      } else {
        logger.log('New session being created, skipping URL sync');
      }
      return; // Return in both cases during session creation
    }

    /**
     * WHY: Skip processing if URL hasn't actually changed
     *
     * This is the key fix for the race condition. Without this check:
     * - useEffect would fire multiple times with the same urlSessionId
     * - Each fire would call switchSession/selectSession, causing unnecessary API calls
     * - More critically, it would fire with STALE values before URL update completes
     *
     * Exception: On initial render (isInitialRender=true), we always process
     * to ensure the initial page load works correctly.
     */
    if (!isInitialRender && !urlActuallyChanged) {
      return;
    }

    if (!urlSessionId) {
      /**
       * WHY: Only clear session when URL actually changed to /chat
       *
       * Before this fix, when navigating from /chat/:sessionId to /chat:
       * 1. useEffect fired with old sessionId (race condition)
       * 2. Then fired again with urlSessionId = undefined
       * 3. But by then, chatStore was already in wrong state
       *
       * Now we only clear when:
       * - URL genuinely changed (urlActuallyChanged = true)
       * - Previous URL had a sessionId (previousUrlSessionId exists)
       * - Current URL has no sessionId (urlSessionId is undefined)
       *
       * This ensures clearActiveSession is called exactly once per navigation to /chat.
       */
      if (urlActuallyChanged && previousUrlSessionId) {
        logger.log('Clearing active session for new chat preparation');
        clearActiveSession();
      }
      return;
    }

    // Skip if already synced to this session
    if (urlSessionId === activeSessionId) {
      return;
    }

    /**
     * WHY: Parallel fetch of session events
     *
     * When URL has sessionId, fetch events immediately without waiting
     * for session list API. This enables parallel execution:
     * - sessions API (list) running in background
     * - events API (specific session) running in parallel
     *
     * This reduces perceived latency on page reload/direct URL access.
     */
    logger.log(`Selecting session (parallel fetch): ${urlSessionId}`);

    // Switch active session in chatStore
    switchSession(urlSessionId);

    // Fetch events in sessionStore
    selectSession(urlSessionId);
  }, [
    urlSessionId,
    activeSessionId,
    isCreatingSession,
    selectSession,
    clearActiveSession,
    switchSession,
    finalizeNewSession,
  ]);

  // Restore session history to chatStore
  useEffect(() => {
    if (urlSessionId && activeSessionId === urlSessionId && sessionEvents.length > 0) {
      logger.log(`Restoring session history to ChatStore: ${urlSessionId}`);
      loadSessionHistory(urlSessionId, sessionEvents);
    }
  }, [urlSessionId, activeSessionId, sessionEvents, loadSessionHistory]);

  // Create new session + navigate
  const createAndNavigateToNewSession = useCallback(() => {
    const newSessionId = createNewSession();
    navigate(`/chat/${newSessionId}`, { replace: true });
    // Note: finalizeNewSession is called in useEffect when URL sync completes
    return newSessionId;
  }, [navigate, createNewSession]);

  return {
    currentSessionId: urlSessionId || null,
    isNewChat: !urlSessionId,
    createAndNavigateToNewSession,
  };
}
