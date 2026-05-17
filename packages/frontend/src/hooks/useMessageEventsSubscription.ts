/**
 * Message Events Subscription Hook
 *
 * Subscribe to real-time message updates via shared AppSync Events WebSocket connection.
 * This enables cross-tab/cross-device synchronization and recovery after page reload.
 */
import { useEffect, useRef, useCallback, useMemo } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import { useAppSyncSubscription } from './useAppSyncSubscription';
import {
  useAppSyncConnectionState,
  useAppSyncConnectionStore,
} from '../stores/appsyncConnectionStore';
import type { MessageContent, Message } from '../types/index';
import { randomId } from '../utils/randomId';
import { logger } from '../utils/logger';

// ============================================================
// Constants & Channel Configuration
// ============================================================

/**
 * Channel prefix for message events
 * Full channel path: /messages/{userId}/{sessionId}
 */
const CHANNEL_PREFIX = '/messages';

/**
 * Subscription ID prefix for message events
 * Full subscription ID: message-subscription-{sessionId}
 */
const SUBSCRIPTION_ID_PREFIX = 'message-subscription';

/**
 * Build channel path for message subscription
 */
function buildChannel(userId: string, sessionId: string): string {
  return `${CHANNEL_PREFIX}/${userId}/${sessionId}`;
}

/**
 * Build subscription ID for message subscription
 * Note: Each session has its own subscription
 */
function buildSubscriptionId(sessionId: string): string {
  return `${SUBSCRIPTION_ID_PREFIX}-${sessionId}`;
}

// ============================================================
// Types
// ============================================================

/**
 * Message event from Agent handler
 */
interface MessageEvent {
  type: 'MESSAGE_ADDED' | 'AGENT_COMPLETE' | 'AGENT_ERROR';
  sessionId: string;
  message?: {
    role: 'user' | 'assistant';
    content: unknown[];
    timestamp: string;
  };
  error?: string;
  requestId?: string;
}

// ============================================================
// Content Conversion Helpers
// ============================================================

/**
 * Convert API content to local MessageContent type
 *
 * Agent SDK ContentBlock types:
 * - textBlock: { type: 'textBlock', text: string }
 * - toolUseBlock: { type: 'toolUseBlock', toolUseId: string, name: string, input: object }
 * - toolResultBlock: { type: 'toolResultBlock', toolUseId: string, content: string }
 *
 * Frontend MessageContent types:
 * - text: { type: 'text', text: string }
 * - toolUse: { type: 'toolUse', toolUse: ToolUse }
 * - toolResult: { type: 'toolResult', toolResult: ToolResult }
 */
function convertContent(apiContent: unknown): MessageContent {
  const content = apiContent as Record<string, unknown>;

  // textBlock → text (Agent SDK format)
  if (content.type === 'textBlock' && typeof content.text === 'string') {
    return { type: 'text', text: content.text };
  }

  // text format (direct)
  if (content.type === 'text' && typeof content.text === 'string') {
    return { type: 'text', text: content.text };
  }

  // toolUseBlock → toolUse
  if (content.type === 'toolUseBlock') {
    return {
      type: 'toolUse',
      toolUse: {
        id: (content.toolUseId as string) || '',
        name: (content.name as string) || 'unknown',
        input: (content.input as Record<string, unknown>) || {},
        status: 'completed',
      },
    };
  }

  // toolResultBlock → toolResult
  if (content.type === 'toolResultBlock') {
    return {
      type: 'toolResult',
      toolResult: {
        toolUseId: (content.toolUseId as string) || '',
        content:
          typeof content.content === 'string'
            ? content.content
            : JSON.stringify(content.content || ''),
        isError: (content.isError as boolean) || false,
      },
    };
  }

  // Pass through for already-converted or unknown types
  return content as unknown as MessageContent;
}

// ============================================================
// Hook
// ============================================================

/**
 * Custom hook for subscribing to real-time message updates
 *
 * ## WHY: Two-stage deduplication guard for MESSAGE_ADDED events
 *
 * Messages arrive via two channels simultaneously:
 * 1. HTTP Streaming (fast) — text deltas build the message in real-time
 * 2. AppSync Events (slow) — publishMessageEvent() in agent handler uses
 *    SigV4 signing + HTTP POST to AppSync HTTP endpoint, which takes longer
 *
 * Without guards, the sender tab displays the same message twice:
 * once from HTTP stream, once from AppSync.
 *
 * Guard 1 (isStreaming): Covers events arriving DURING streaming.
 * Guard 2 (grace period): Covers events arriving AFTER streaming completes.
 *   publishMessageEvent() is fire-and-forget (.catch()) in the agent handler,
 *   so it often completes after serverCompletionEvent is sent via HTTP stream.
 *
 * WHY NOT disable subscription (enabled=false) during streaming:
 * We tried setting enabled={!!sessionId && !!userId && !isLoading} to disable
 * the AppSync subscription during HTTP streaming. This failed because when
 * isLoading flipped to false, React re-rendered and re-subscribed, and the
 * late-arriving AppSync event was delivered immediately after re-subscribe,
 * still causing duplicates.
 *
 * WHY NOT content-based deduplication:
 * The original approach compared message text (first 200 chars). This had gaps:
 * - Tool-only messages have empty text → comparison was skipped entirely
 * - Only first 200 chars compared → unreliable for long messages
 * - No stable message ID shared between HTTP stream and AppSync event
 *
 * @param sessionId - The active session ID to subscribe to
 */
export function useMessageEventsSubscription(sessionId: string | null) {
  // Track current session for event filtering
  const currentSessionIdRef = useRef(sessionId);
  const prevSessionIdRef = useRef<string | null>(null);

  // Get auth state
  const user = useAuthStore((state) => state.user);
  const userId = user?.userId;
  const connectionState = useAppSyncConnectionState();
  const unsubscribe = useAppSyncConnectionStore((state) => state.unsubscribe);

  // Update current session ref
  useEffect(() => {
    currentSessionIdRef.current = sessionId;
  }, [sessionId]);

  /**
   * Handle incoming message events
   */
  const handleMessageEvent = useCallback((eventData: string) => {
    try {
      const event = JSON.parse(eventData) as MessageEvent;
      logger.log('Received message event:', event);

      const chatStore = useChatStore.getState();

      // Only process events for the active session
      if (event.sessionId !== currentSessionIdRef.current) {
        logger.log(
          `Message event for different session, ignoring (current: ${currentSessionIdRef.current}, event: ${event.sessionId})`
        );
        return;
      }

      switch (event.type) {
        case 'MESSAGE_ADDED': {
          if (!event.message) break;

          const sessionState = chatStore.getSessionState(event.sessionId);
          if (!sessionState) break;

          // Guard 1: Skip while HTTP streaming is active (sender tab).
          // During streaming, the sender tab already receives all messages
          // via HTTP stream — AppSync events would be duplicates.
          // WHY isStreaming instead of isLoading: After page reload, we set
          // isLoading=true upon receiving assistant MESSAGE_ADDED events to
          // show TypingIndicator. If Guard 1 checked isLoading, subsequent
          // MESSAGE_ADDED events would be blocked. isStreaming is only true
          // on messages created by the HTTP stream handler (sender tab),
          // so it precisely identifies "HTTP streaming in progress" without
          // conflicting with the AppSync-driven isLoading state.
          const hasStreamingMessage = sessionState.messages.some((msg) => msg.isStreaming);
          if (hasStreamingMessage) {
            logger.log('Skipping message event (HTTP streaming active)');
            break;
          }

          // Guard 2: Skip during grace period after streaming completed.
          // WHY: publishMessageEvent() in the agent handler is fire-and-forget
          // (.catch()) and involves SigV4 signing + HTTPS POST to AppSync HTTP
          // endpoint, which typically takes 1-5 seconds. The HTTP stream's
          // serverCompletionEvent arrives first (isLoading→false), then the
          // AppSync event arrives later — this grace period catches those late events.
          // WHY 10 seconds: provides a safe margin for slow networks without
          // meaningfully delaying cross-tab sync (which only matters for OTHER tabs).
          const GRACE_PERIOD_MS = 10_000;
          const lastCompleted = chatStore.lastStreamCompletedAt?.[event.sessionId];
          if (lastCompleted && Date.now() - lastCompleted < GRACE_PERIOD_MS) {
            logger.log('Skipping message event (grace period after streaming)');
            break;
          }

          // Convert content
          const contents: MessageContent[] = event.message.content.map(convertContent);

          // Add message to store
          const newMessage: Message = {
            id: randomId(),
            type: event.message.role,
            contents,
            timestamp: new Date(event.message.timestamp),
            isStreaming: false,
          };

          const { sessions } = chatStore;
          const currentState = sessions[event.sessionId] || {
            messages: [],
            isLoading: false,
            error: null,
            lastUpdated: new Date(),
          };

          useChatStore.setState({
            sessions: {
              ...sessions,
              [event.sessionId]: {
                ...currentState,
                messages: [...currentState.messages, newMessage],
                // WHY: Set isLoading=true when receiving assistant messages via AppSync.
                // After page reload, HTTP streaming state is lost (isLoading/isStreaming
                // are both false). When the agent is still running, AppSync Events
                // continue to arrive. Setting isLoading=true here restores the
                // "agent is processing" visual state (TypingIndicator + disabled input).
                // AGENT_COMPLETE or AGENT_ERROR events will set isLoading back to false.
                // This does NOT affect the sender tab because Guard 1/2 skip
                // MESSAGE_ADDED events during and shortly after HTTP streaming.
                isLoading: event.message.role === 'assistant' ? true : currentState.isLoading,
                lastUpdated: new Date(),
              },
            },
          });

          logger.log(`Added message from event: ${event.message.role}`);
          break;
        }

        case 'AGENT_COMPLETE': {
          const sessionState = chatStore.getSessionState(event.sessionId);
          if (!sessionState) break;

          const { sessions } = chatStore;
          const currentState = sessions[event.sessionId];
          if (!currentState) break;

          const updatedMessages = currentState.messages.map((msg) =>
            msg.isStreaming ? { ...msg, isStreaming: false } : msg
          );

          useChatStore.setState({
            sessions: {
              ...sessions,
              [event.sessionId]: {
                ...currentState,
                messages: updatedMessages,
                isLoading: false,
              },
            },
          });

          logger.log('Agent complete event processed');
          break;
        }

        case 'AGENT_ERROR': {
          logger.error('Agent error event:', event.error);
          const { sessions } = chatStore;
          const currentState = sessions[event.sessionId];
          if (!currentState) break;

          useChatStore.setState({
            sessions: {
              ...sessions,
              [event.sessionId]: {
                ...currentState,
                isLoading: false,
                error: event.error || 'Unknown error',
              },
            },
          });
          break;
        }
      }
    } catch (error) {
      logger.error('Failed to parse message event:', error);
    }
  }, []);

  // Build channel and subscription ID for current session
  const channel = useMemo(
    () => (userId && sessionId ? buildChannel(userId, sessionId) : null),
    [userId, sessionId]
  );
  const subscriptionId = useMemo(
    () => (sessionId ? buildSubscriptionId(sessionId) : null),
    [sessionId]
  );

  // Handle session changes - unsubscribe from previous session
  useEffect(() => {
    const prevSessionId = prevSessionIdRef.current;

    // Unsubscribe from previous session if different
    if (prevSessionId && prevSessionId !== sessionId) {
      unsubscribe(buildSubscriptionId(prevSessionId));
    }

    // Update previous session ref
    prevSessionIdRef.current = sessionId;
  }, [sessionId, unsubscribe]);

  /**
   * WHY NOT: We do NOT use !isLoading in the enabled condition.
   *
   * Previously we tried: enabled={!!sessionId && !!userId && !isLoading}
   * This disabled the subscription during streaming, but when isLoading
   * flipped to false, React re-subscribed and the late-arriving AppSync
   * event was immediately delivered, still causing duplicates.
   *
   * Instead, we keep the subscription always active and filter events
   * in the handler using the two-stage guard above.
   */
  useAppSyncSubscription(channel, subscriptionId, handleMessageEvent, !!sessionId && !!userId);

  return {
    isConnected: connectionState.isConnected,
  };
}
