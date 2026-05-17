/**
 * Session Events Subscription Hook
 *
 * Subscribe to real-time session updates via shared AppSync Events WebSocket connection.
 */
import { useCallback, useMemo } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useAuthStore } from '../stores/authStore';
import { useAppSyncSubscription } from './useAppSyncSubscription';
import { useAppSyncConnectionState } from '../stores/appsyncConnectionStore';
import { logger } from '../utils/logger';
import type { SessionType } from '../api/sessions';

// ============================================================
// Constants & Channel Configuration
// ============================================================

/**
 * Channel prefix for session events
 * Full channel path: /sessions/{userId}
 */
const CHANNEL_PREFIX = '/sessions';

/**
 * Subscription ID for session events (fixed, one per user)
 */
const SUBSCRIPTION_ID = 'session-subscription';

/**
 * Build channel path for session subscription
 */
function buildChannel(userId: string): string {
  return `${CHANNEL_PREFIX}/${userId}`;
}

/**
 * Build subscription ID for session subscription
 * Note: Session subscription uses a fixed ID (one per user)
 */
function buildSubscriptionId(): string {
  return SUBSCRIPTION_ID;
}

// ============================================================
// Types
// ============================================================

/**
 * Session event from DynamoDB Streams
 */
interface SessionEvent {
  type: 'INSERT' | 'MODIFY' | 'REMOVE';
  sessionId: string;
  title?: string;
  agentId?: string;
  sessionType?: SessionType;
  updatedAt?: string;
  createdAt?: string;
}

// ============================================================
// Hook
// ============================================================

/**
 * Custom hook for subscribing to real-time session updates
 *
 * This hook uses the shared WebSocket connection to AppSync Events API
 * and listens for session changes (INSERT, MODIFY, REMOVE).
 */
export function useSessionEventsSubscription() {
  // Get user ID for channel subscription
  const user = useAuthStore((state) => state.user);
  const userId = user?.userId;
  const connectionState = useAppSyncConnectionState();

  /**
   * Handle incoming session events
   */
  const handleSessionEvent = useCallback((eventData: string) => {
    try {
      const event = JSON.parse(eventData) as SessionEvent;
      logger.log('Received session event:', event);

      const store = useSessionStore.getState();

      switch (event.type) {
        case 'INSERT': {
          // Check if session already exists (might be added optimistically)
          const exists = store.sessions.some((s) => s.sessionId === event.sessionId);
          if (!exists) {
            store.addOptimisticSession(event.sessionId, event.title, event.sessionType);
          } else if (event.sessionType) {
            // WHY: The session may have been added optimistically before the
            // stream event arrived (e.g., HTTP POST /sessions response) without
            // a sessionType. Patch it here so the sidebar badge (`[Sub]` /
            // `[Event]`) renders without requiring a page reload.
            store.updateSessionType(event.sessionId, event.sessionType);
          }
          break;
        }

        case 'MODIFY': {
          // Update session title if changed
          if (event.title) {
            store.updateSessionTitle(event.sessionId, event.title);
          }
          // sessionType is immutable after creation in backend, but patch it
          // defensively in case an INSERT event was missed.
          if (event.sessionType) {
            store.updateSessionType(event.sessionId, event.sessionType);
          }
          break;
        }

        case 'REMOVE': {
          // Session was deleted (possibly by another device/tab)
          // Refresh to sync
          store.refreshSessions();
          break;
        }
      }
    } catch (error) {
      logger.error('Failed to parse session event:', error);
    }
  }, []);

  // Build channel and subscription ID
  const channel = useMemo(() => (userId ? buildChannel(userId) : null), [userId]);
  const subscriptionId = useMemo(() => (userId ? buildSubscriptionId() : null), [userId]);

  // Subscribe to session channel using shared connection
  useAppSyncSubscription(channel, subscriptionId, handleSessionEvent, !!userId);

  return {
    isConnected: connectionState.isConnected,
  };
}
