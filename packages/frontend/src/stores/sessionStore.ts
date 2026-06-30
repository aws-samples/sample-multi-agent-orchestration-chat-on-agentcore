/**
 * Session Management Store
 * State management for session list and active session
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import toast from 'react-hot-toast';
import {
  fetchSessions,
  fetchSessionEvents,
  deleteSession as deleteSessionApi,
} from '../api/sessions';
import type { SessionSummary, ConversationMessage, SessionType } from '../api/sessions';
import { ApiError } from '../types/errors';
import i18n from '../i18n';
import { useAgentStore } from './agentStore';
import { useStorageStore } from './storageStore';
import { logger } from '../utils/logger';
import { extractErrorMessage } from '../utils/store-helpers';
import { generateSessionId } from '../utils/sessionId';
import { isSessionId, isAgentId } from '@moca/core';

/**
 * Default page size for session list
 */
const DEFAULT_PAGE_SIZE = 50;

/**
 * Session store state type definition
 */
interface SessionState {
  sessions: SessionSummary[];
  isLoadingSessions: boolean;
  sessionsError: string | null;
  hasLoadedOnce: boolean;

  // Pagination state
  nextToken: string | null;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;

  activeSessionId: string | null;
  sessionEvents: ConversationMessage[];
  isLoadingEvents: boolean;
  eventsError: string | null;

  isCreatingSession: boolean;
}

/**
 * Session store actions type definition
 */
interface SessionActions {
  loadSessions: () => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  loadAllSessions: () => Promise<void>;
  selectSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  deleteMultipleSessions: (sessionIds: string[]) => Promise<void>;
  setActiveSessionId: (sessionId: string) => void;
  clearActiveSession: () => void;
  setSessionsError: (error: string | null) => void;
  setEventsError: (error: string | null) => void;
  clearErrors: () => void;
  refreshSessions: () => Promise<void>;
  createNewSession: () => string;
  finalizeNewSession: () => void;
  addOptimisticSession: (
    sessionId: string,
    title?: string,
    sessionType?: SessionType,
    agentId?: string
  ) => void;
  updateSessionTitle: (sessionId: string, title: string) => void;
  updateSessionType: (sessionId: string, sessionType: SessionType) => void;
  updateSessionAgentId: (sessionId: string, agentId: string) => void;
}

/**
 * Session management store
 */
type SessionStore = SessionState & SessionActions;

export const useSessionStore = create<SessionStore>()(
  devtools(
    (set, get) => ({
      // State
      sessions: [],
      isLoadingSessions: false,
      sessionsError: null,
      hasLoadedOnce: false,

      // Pagination state
      nextToken: null,
      hasMoreSessions: false,
      isLoadingMoreSessions: false,

      activeSessionId: null,
      sessionEvents: [],
      isLoadingEvents: false,
      eventsError: null,
      isCreatingSession: false,

      // Actions
      loadSessions: async () => {
        try {
          set({ isLoadingSessions: true, sessionsError: null });

          logger.log('Loading all sessions...');
          const result = await fetchSessions({ limit: DEFAULT_PAGE_SIZE });

          set({
            sessions: result.sessions,
            nextToken: result.nextToken || null,
            hasMoreSessions: result.hasMore,
            isLoadingSessions: false,
            sessionsError: null,
            hasLoadedOnce: true,
          });

          logger.log(
            `Session list loaded: ${result.sessions.length} items, hasMore: ${result.hasMore}`
          );
        } catch (error) {
          const errorMessage = extractErrorMessage(error, 'Failed to load session list');
          logger.error('Session list loading error:', error);

          set({
            sessions: [],
            nextToken: null,
            hasMoreSessions: false,
            isLoadingSessions: false,
            sessionsError: errorMessage,
            hasLoadedOnce: true,
          });
        }
      },

      loadMoreSessions: async () => {
        const { nextToken, hasMoreSessions, isLoadingMoreSessions, sessions } = get();

        // Skip if no more sessions or already loading
        if (!hasMoreSessions || isLoadingMoreSessions || !nextToken) {
          logger.log('Skipping loadMoreSessions:', {
            hasMoreSessions,
            isLoadingMoreSessions,
            hasNextToken: !!nextToken,
          });
          return;
        }

        try {
          set({ isLoadingMoreSessions: true });

          logger.log('Loading more sessions...');
          const result = await fetchSessions({
            limit: DEFAULT_PAGE_SIZE,
            nextToken,
          });

          set({
            sessions: [...sessions, ...result.sessions],
            nextToken: result.nextToken || null,
            hasMoreSessions: result.hasMore,
            isLoadingMoreSessions: false,
          });

          logger.log(
            `More sessions loaded: ${result.sessions.length} items, total: ${sessions.length + result.sessions.length}, hasMore: ${result.hasMore}`
          );
        } catch (error) {
          const errorMessage = extractErrorMessage(error, 'Failed to load more sessions');
          logger.error('Load more sessions error:', error);

          set({
            isLoadingMoreSessions: false,
            sessionsError: errorMessage,
          });
        }
      },

      loadAllSessions: async () => {
        const { loadSessions, loadMoreSessions } = get();

        logger.log('Loading all sessions...');

        // First, load initial sessions
        await loadSessions();

        // Then, keep loading more until no more sessions
        let iterationCount = 0;
        const maxIterations = 100; // Safety limit to prevent infinite loops

        while (get().hasMoreSessions && get().nextToken && iterationCount < maxIterations) {
          await loadMoreSessions();
          iterationCount++;
        }

        const totalSessions = get().sessions.length;
        logger.log(`All sessions loaded: ${totalSessions} items in ${iterationCount + 1} requests`);
      },

      selectSession: async (sessionId: string) => {
        try {
          set({
            isLoadingEvents: true,
            eventsError: null,
            activeSessionId: sessionId,
          });

          logger.log(`Selecting session: ${sessionId}`);

          // Restore agent and storage path from session data
          const { sessions } = get();
          const session = sessions.find((s) => s.sessionId === sessionId);

          if (session) {
            // Restore agent if session has agentId
            if (session.agentId) {
              const agentStore = useAgentStore.getState();
              const agent = agentStore.getAgent(session.agentId);
              if (agent) {
                agentStore.selectAgent(agent);
                logger.log(`Agent switched to: ${agent.name} (${session.agentId})`);
              } else {
                logger.warn(`Agent not found for agentId: ${session.agentId}`);
              }
            }

            // Restore storage path if session has storagePath
            if (session.storagePath) {
              const storageStore = useStorageStore.getState();
              storageStore.setAgentWorkingDirectory(session.storagePath);
              logger.log(`Storage path switched to: ${session.storagePath}`);
            }
          }

          const events = await fetchSessionEvents(sessionId);

          set({
            sessionEvents: events,
            isLoadingEvents: false,
            eventsError: null,
          });

          logger.log(`Session conversation history loaded: ${events.length} items`);
        } catch (error) {
          // Handle a missing/unowned session - redirect to /chat. The backend
          // returns 404 (NOT_FOUND) for a session that does not exist or is
          // not owned by the caller; older deployments returned 403, so accept
          // both for backward compatibility during rollout.
          if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
            logger.warn(`Session not accessible: ${sessionId}`);
            toast.error(i18n.t('error.forbidden'));
            set({
              activeSessionId: null,
              sessionEvents: [],
              isLoadingEvents: false,
              eventsError: null,
            });
            window.location.href = '/chat';
            return;
          }

          const errorMessage = extractErrorMessage(
            error,
            'Failed to load session conversation history'
          );
          logger.error('Session conversation history loading error:', error);

          set({
            sessionEvents: [],
            isLoadingEvents: false,
            eventsError: errorMessage,
          });
        }
      },

      deleteSession: async (sessionId: string) => {
        // 1. Save session for potential rollback
        const { sessions, activeSessionId } = get();
        const sessionToDelete = sessions.find((s) => s.sessionId === sessionId);
        const originalIndex = sessions.findIndex((s) => s.sessionId === sessionId);

        // 2. Optimistically remove from local state immediately
        const updatedSessions = sessions.filter((s) => s.sessionId !== sessionId);
        set({ sessions: updatedSessions });

        // Clear active session if it's the deleted one
        if (activeSessionId === sessionId) {
          set({
            activeSessionId: null,
            sessionEvents: [],
            eventsError: null,
          });
        }

        logger.log(`Optimistically removed session: ${sessionId}`);

        try {
          // 3. Call API to delete session (in background)
          await deleteSessionApi(sessionId);
          logger.log(`Session deleted from server: ${sessionId}`);
          toast.success(i18n.t('chat.sessionDeleted'));
        } catch (error) {
          // 4. Rollback on error - restore the session
          logger.error('Session deletion error, rolling back:', error);

          if (sessionToDelete) {
            const currentSessions = get().sessions;
            // Restore at original position if possible
            const restoredSessions = [...currentSessions];
            const insertIndex = Math.min(originalIndex, restoredSessions.length);
            restoredSessions.splice(insertIndex, 0, sessionToDelete);
            set({ sessions: restoredSessions });
          }

          const errorMessage = extractErrorMessage(error, 'Failed to delete session');
          toast.error(errorMessage);
          throw error;
        }
      },

      deleteMultipleSessions: async (sessionIds: string[]) => {
        if (sessionIds.length === 0) return;

        // 1. Save sessions for potential rollback
        const { sessions, activeSessionId } = get();
        const sessionsToDelete = sessions.filter((s) => sessionIds.includes(s.sessionId));
        const sessionIdsSet = new Set(sessionIds);

        // 2. Optimistically remove from local state immediately
        const updatedSessions = sessions.filter((s) => !sessionIdsSet.has(s.sessionId));
        set({ sessions: updatedSessions });

        // Clear active session if it's one of the deleted ones
        if (activeSessionId && sessionIdsSet.has(activeSessionId)) {
          set({
            activeSessionId: null,
            sessionEvents: [],
            eventsError: null,
          });
        }

        logger.log(`Optimistically removed ${sessionIds.length} sessions`);

        // 3. Call API to delete sessions (in parallel, in background)
        const results = await Promise.allSettled(
          sessionIds.map((sessionId) => deleteSessionApi(sessionId))
        );

        // 4. Check results
        const failedCount = results.filter((r) => r.status === 'rejected').length;
        const successCount = results.filter((r) => r.status === 'fulfilled').length;

        if (failedCount > 0) {
          logger.error(`${failedCount} session deletions failed`);

          // Rollback failed deletions
          const failedIndices = results
            .map((r, i) => (r.status === 'rejected' ? i : -1))
            .filter((i) => i >= 0);
          const failedSessionIds = failedIndices.map((i) => sessionIds[i]);
          const sessionsToRestore = sessionsToDelete.filter((s) =>
            failedSessionIds.includes(s.sessionId)
          );

          if (sessionsToRestore.length > 0) {
            const currentSessions = get().sessions;
            set({ sessions: [...sessionsToRestore, ...currentSessions] });
          }

          if (successCount > 0) {
            toast.success(i18n.t('chat.sessionsDeleted', { count: successCount }));
          }
          toast.error(`${failedCount} sessions failed to delete`);
        } else {
          logger.log(`${successCount} sessions deleted from server`);
          toast.success(i18n.t('chat.sessionsDeleted', { count: successCount }));
        }
      },

      setActiveSessionId: (sessionId: string) => {
        set({
          activeSessionId: sessionId,
          sessionEvents: [],
          eventsError: null,
          isLoadingEvents: false,
        });
        logger.log(`Set new session as active: ${sessionId}`);
      },

      clearActiveSession: () => {
        set({
          activeSessionId: null,
          sessionEvents: [],
          eventsError: null,
          isLoadingEvents: false,
        });
        logger.log('Cleared active session');
      },

      setSessionsError: (error: string | null) => {
        set({ sessionsError: error });
      },

      setEventsError: (error: string | null) => {
        set({ eventsError: error });
      },

      clearErrors: () => {
        set({
          sessionsError: null,
          eventsError: null,
        });
      },

      refreshSessions: async () => {
        // Reload all sessions (without clearing first to prevent UI flash)
        const { loadSessions } = get();
        logger.log('Refreshing session list...');
        await loadSessions();
      },

      createNewSession: () => {
        const newSessionId = generateSessionId();
        set({
          activeSessionId: newSessionId,
          sessionEvents: [],
          eventsError: null,
          isLoadingEvents: false,
          isCreatingSession: true,
        });
        logger.log(`Created new session: ${newSessionId}`);
        return newSessionId;
      },

      finalizeNewSession: () => {
        set({ isCreatingSession: false });
        logger.log('New session creation completed');
      },

      addOptimisticSession: (
        sessionId: string,
        title?: string,
        sessionType?: SessionType,
        agentId?: string
      ) => {
        const { sessions } = get();

        // Validate at the boundary: callers pass raw strings (AppSync events,
        // generated IDs, etc.), so we narrow to `SessionId` here rather than
        // forcing every call site to parse. Malformed IDs are silently
        // dropped with a warning — throwing would escape the AppSync event
        // handler as an unhandled rejection and kill the subscription.
        if (!isSessionId(sessionId)) {
          logger.warn(`Invalid sessionId format, skipping optimistic add: "${sessionId}"`);
          return;
        }

        // Check if session already exists
        const exists = sessions.some((s) => s.sessionId === sessionId);
        if (exists) {
          logger.log(`Session ${sessionId} already exists, skipping optimistic add`);
          return;
        }

        // Create optimistic session with title or placeholder. `sessionId` is
        // narrowed to `SessionId` by the type guard above.
        const optimisticSession: SessionSummary = {
          sessionId,
          title: title || 'New conversation...',
          sessionType,
          // Narrow to branded `AgentId` at the boundary; drop malformed values
          // rather than forcing the branded type onto an unvalidated string.
          agentId: agentId && isAgentId(agentId) ? agentId : undefined,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        // Add to beginning of list
        set({
          sessions: [optimisticSession, ...sessions],
        });

        logger.log(`Optimistically added session: ${sessionId} - "${optimisticSession.title}"`);
      },

      updateSessionTitle: (sessionId: string, title: string) => {
        const { sessions } = get();

        const updatedSessions = sessions.map((session) =>
          session.sessionId === sessionId
            ? { ...session, title, updatedAt: new Date().toISOString() }
            : session
        );

        set({ sessions: updatedSessions });
        logger.log(`Updated session title: ${sessionId} - "${title}"`);
      },

      updateSessionType: (sessionId: string, sessionType: SessionType) => {
        const { sessions } = get();

        // Skip update if already set to the same value to avoid unnecessary
        // re-renders and log noise (INSERT + MODIFY stream events often
        // deliver the same sessionType in quick succession).
        const target = sessions.find((s) => s.sessionId === sessionId);
        if (!target || target.sessionType === sessionType) {
          return;
        }

        const updatedSessions = sessions.map((session) =>
          session.sessionId === sessionId ? { ...session, sessionType } : session
        );

        set({ sessions: updatedSessions });
        logger.log(`Updated session type: ${sessionId} - "${sessionType}"`);
      },

      updateSessionAgentId: (sessionId: string, agentId: string) => {
        const { sessions } = get();

        // Narrow to branded `AgentId` at the boundary; ignore malformed values.
        if (!isAgentId(agentId)) {
          logger.warn(`Invalid agentId format, skipping agentId patch: "${agentId}"`);
          return;
        }

        // Skip update if already set to the same value to avoid unnecessary
        // re-renders and log noise (INSERT + MODIFY stream events often
        // deliver the same agentId in quick succession).
        const target = sessions.find((s) => s.sessionId === sessionId);
        if (!target || target.agentId === agentId) {
          return;
        }

        const updatedSessions = sessions.map((session) =>
          session.sessionId === sessionId ? { ...session, agentId } : session
        );

        set({ sessions: updatedSessions });
        logger.log(`Updated session agentId: ${sessionId} - "${agentId}"`);
      },
    }),
    {
      name: 'session-store',
      enabled: import.meta.env.DEV,
    }
  )
);

/**
 * Session-related selector hooks
 */
export const useSessionById = (sessionId: string) => {
  return useSessionStore((state) => state.sessions.find((s) => s.sessionId === sessionId));
};

export const useIsAnySessionLoading = () => {
  return useSessionStore(
    (state) => state.isLoadingSessions || state.isLoadingEvents || state.isLoadingMoreSessions
  );
};

/**
 * Session selectors (non-reactive, for use outside React components)
 */
export const sessionSelectors = {
  getSessionById: (sessionId: string) => {
    const { sessions } = useSessionStore.getState();
    return sessions.find((session) => session.sessionId === sessionId);
  },

  isAnyLoading: () => {
    const { isLoadingSessions, isLoadingEvents, isLoadingMoreSessions } =
      useSessionStore.getState();
    return isLoadingSessions || isLoadingEvents || isLoadingMoreSessions;
  },

  hasAnyError: () => {
    const { sessionsError, eventsError } = useSessionStore.getState();
    return !!sessionsError || !!eventsError;
  },

  getAllErrors: () => {
    const { sessionsError, eventsError } = useSessionStore.getState();
    return [sessionsError, eventsError].filter(Boolean) as string[];
  },
};
