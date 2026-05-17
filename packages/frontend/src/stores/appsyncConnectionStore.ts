/**
 * AppSync Events Connection Store
 *
 * Manages a single shared WebSocket connection to AppSync Events API.
 * Multiple subscription hooks can use this shared connection.
 *
 * ## WHY: Single Shared Connection Architecture
 *
 * We use a single shared WebSocket connection instead of creating one per subscription because:
 * 1. AppSync Events API has connection limits per client
 * 2. Multiple WebSocket connections consume unnecessary resources
 * 3. Connection management (auth, reconnection) is centralized in one place
 * 4. All subscriptions benefit from the same reconnection logic automatically
 *
 * This store acts as a connection pool with a single connection that routes
 * messages to appropriate handlers based on subscription IDs.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import { useAuthStore } from './authStore';
import { appsyncEventsConfig } from '../config/appsync-events';
import { authService } from '../lib/auth';
import {
  buildHttpHostFromEndpoint,
  createAuthProtocol,
  calculateReconnectDelay,
} from '../utils/appsync';
import type { AppSyncMessage } from '../types/appsync';
import { logger } from '../utils/logger';

/**
 * Maximum number of reconnection attempts
 */
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Subscription handler type - callback function to process incoming events
 */
type SubscriptionHandler = (event: string) => void;

/**
 * AppSync connection state
 */
interface AppSyncConnectionState {
  // Connection state
  isConnected: boolean;
  isConnectionAcknowledged: boolean;
  httpHost: string;

  // Internal refs (not reactive - prefixed with _ to indicate internal use)
  _ws: WebSocket | null;
  _reconnectTimeout: NodeJS.Timeout | null;
  _keepAliveTimeout: NodeJS.Timeout | null;
  _reconnectAttempts: number;
  _isConnecting: boolean;
  _subscriptionHandlers: Map<string, SubscriptionHandler>;

  /**
   * WHY: _channelMap stores subscriptionId → channel path mapping
   *
   * We need to store the channel path for each subscription because:
   * 1. When reconnecting after connection loss, we need to re-subscribe to the same channels
   * 2. AppSync requires the full channel path (e.g., '/sessions/user123') for subscription
   * 3. Using subscriptionId as key allows multiple subscriptions to the same channel
   *    with different handlers (e.g., different components listening to the same channel)
   *
   * Using Map instead of Set because we need to preserve the channel path,
   * not just track whether a subscription exists.
   */
  _channelMap: Map<string, string>;

  /**
   * WHY: _pendingSubscriptions tracks subscriptions waiting for server acknowledgment
   *
   * This Set prevents duplicate subscription requests because:
   * 1. AppSync returns DuplicatedOperationError if we send subscribe with same ID twice
   * 2. Between sending 'subscribe' and receiving 'subscribe_success', the subscription is "pending"
   * 3. Multiple React renders or reconnection logic might try to subscribe again
   * 4. By checking this Set, we skip subscriptions that are already in-flight
   */
  _pendingSubscriptions: Set<string>;

  // Actions
  connect: () => void;
  disconnect: () => void;
  subscribe: (channel: string, subscriptionId: string, handler: SubscriptionHandler) => void;
  unsubscribe: (subscriptionId: string) => void;
}

/**
 * Create the AppSync connection store
 */
export const useAppSyncConnectionStore = create<AppSyncConnectionState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    isConnected: false,
    isConnectionAcknowledged: false,
    httpHost: '',

    // Internal refs (see interface comments for WHY explanations)
    _ws: null,
    _reconnectTimeout: null,
    _keepAliveTimeout: null,
    _reconnectAttempts: 0,
    _isConnecting: false,
    _subscriptionHandlers: new Map(),
    _channelMap: new Map(),
    _pendingSubscriptions: new Set(),

    /**
     * Connect to AppSync Events
     */
    connect: async () => {
      const state = get();

      // Prevent multiple simultaneous connection attempts
      if (state._isConnecting) {
        logger.log('Already connecting, skipping...');
        return;
      }

      // Skip if already connected or connecting
      if (
        state._ws &&
        (state._ws.readyState === WebSocket.OPEN || state._ws.readyState === WebSocket.CONNECTING)
      ) {
        logger.log('Already connected or connecting, skipping...');
        return;
      }

      if (!appsyncEventsConfig.isConfigured) {
        logger.log('AppSync Events not configured, skipping');
        return;
      }

      /**
       * WHY: Set _isConnecting BEFORE any async operation
       *
       * connect() is called from useAppSyncConnection hook in React's useEffect.
       * In React StrictMode (development) and with multiple component renders,
       * connect() can be invoked multiple times in rapid succession.
       *
       * The _isConnecting guard at the top prevents duplicate calls, but only if
       * the flag is already true. If we set it AFTER the await (as was originally
       * implemented), the following race condition occurs:
       *
       *   Call 1: _isConnecting=false → passes guard → await getValidAccessToken()
       *   Call 2: _isConnecting=false → passes guard → await getValidAccessToken()
       *   Call 1: set({ _isConnecting: true }) → creates WebSocket #1
       *   Call 2: set({ _isConnecting: true }) → creates WebSocket #2
       *
       * Result: Two WebSocket connections established, each receiving the same
       * AppSync events, causing duplicate message delivery to the UI.
       *
       * WHY NOT module-level lock: We considered using a module-level variable
       * (let connecting = false) instead of Zustand state, but Zustand state is
       * already the single source of truth for connection state and is consistent
       * with the store's existing patterns.
       */
      set({ _isConnecting: true });

      // Get fresh access token (auto-refreshes if expired)
      let accessToken: string;
      try {
        accessToken = (await authService.getTokens()).accessToken;
      } catch (err) {
        logger.log('No auth token available, skipping', err);
        set({ _isConnecting: false });
        return;
      }
      const userId = useAuthStore.getState().user?.userId;

      if (!userId) {
        logger.log('No user id available, skipping');
        set({ _isConnecting: false });
        return;
      }

      // Close existing connection if any
      if (state._ws) {
        state._ws.close(1000, 'Reconnecting');
      }

      try {
        const endpoint = appsyncEventsConfig.realtimeEndpoint;
        const newHttpHost = buildHttpHostFromEndpoint(endpoint);
        const authProtocol = createAuthProtocol(accessToken, newHttpHost);

        logger.log('Connecting to AppSync Events (shared connection)');

        const ws = new WebSocket(endpoint, [authProtocol, 'aws-appsync-event-ws']);

        ws.onopen = () => {
          logger.log('WebSocket connected');
          set({
            _ws: ws,
            _reconnectAttempts: 0,
            _isConnecting: false,
            isConnected: true,
            httpHost: newHttpHost,
          });

          // Send connection init
          ws.send(JSON.stringify({ type: 'connection_init' }));
        };

        ws.onmessage = (event) => {
          const currentState = get();

          try {
            const message: AppSyncMessage = JSON.parse(event.data);

            switch (message.type) {
              case 'connection_ack': {
                logger.log('Connection acknowledged');
                set({ isConnectionAcknowledged: true });

                /**
                 * WHY: Re-subscribe after connection_ack
                 *
                 * AppSync Events protocol requires:
                 * 1. Client sends 'connection_init'
                 * 2. Server responds with 'connection_ack'
                 * 3. Only AFTER connection_ack can we send 'subscribe' messages
                 *
                 * When reconnecting after connection loss, we need to re-subscribe
                 * to all channels that were previously active. The _channelMap
                 * stores these subscriptions so we can restore them.
                 *
                 * We skip subscriptions that are already pending to avoid
                 * DuplicatedOperationError from AppSync.
                 */
                // Get fresh token for re-subscriptions
                authService
                  .getTokens()
                  .then(({ accessToken: freshToken }) => {
                    currentState._channelMap.forEach((channel, subscriptionId) => {
                      // Skip if already pending (subscription was sent before ack)
                      if (currentState._pendingSubscriptions.has(subscriptionId)) {
                        logger.log(`Skipping re-subscribe (already pending): ${subscriptionId}`);
                        return;
                      }

                      const handler = currentState._subscriptionHandlers.get(subscriptionId);
                      if (handler && ws.readyState === WebSocket.OPEN) {
                        logger.log(`Re-subscribing after reconnect: ${subscriptionId}`);

                        // Mark as pending
                        const pending = new Set(get()._pendingSubscriptions);
                        pending.add(subscriptionId);
                        set({ _pendingSubscriptions: pending });

                        ws.send(
                          JSON.stringify({
                            type: 'subscribe',
                            id: subscriptionId,
                            channel,
                            authorization: {
                              Authorization: freshToken,
                              host: currentState.httpHost,
                            },
                          })
                        );
                      }
                    });
                  })
                  .catch((err) => {
                    logger.log('No valid token for re-subscription', err);
                  });
                break;
              }

              case 'subscribe_success': {
                logger.log('Subscription successful:', message.id);
                if (message.id) {
                  const pending = new Set(currentState._pendingSubscriptions);
                  pending.delete(message.id);
                  set({ _pendingSubscriptions: pending });
                }
                break;
              }

              case 'subscribe_error': {
                logger.error('Subscription error:', message);
                if (message.id) {
                  const pending = new Set(currentState._pendingSubscriptions);
                  pending.delete(message.id);
                  set({ _pendingSubscriptions: pending });
                }
                break;
              }

              case 'data': {
                if (message.event && message.id) {
                  // Route to the appropriate handler
                  const handler = currentState._subscriptionHandlers.get(message.id);
                  if (handler) {
                    handler(message.event);
                  }
                }
                break;
              }

              case 'ka': {
                // Keep-alive received
                if (currentState._keepAliveTimeout) {
                  clearTimeout(currentState._keepAliveTimeout);
                }
                break;
              }

              case 'error': {
                logger.error('WebSocket error message:', message);
                break;
              }
            }
          } catch (error) {
            logger.error('Failed to parse WebSocket message:', error);
          }
        };

        ws.onerror = (error) => {
          logger.error('WebSocket error:', error);
          set({ _isConnecting: false });
        };

        ws.onclose = (event) => {
          logger.log(`WebSocket closed: code=${event.code}`);
          const currentState = get();

          set({
            isConnected: false,
            isConnectionAcknowledged: false,
            _isConnecting: false,
            _ws: null,
          });

          // Clear keep-alive timeout
          if (currentState._keepAliveTimeout) {
            clearTimeout(currentState._keepAliveTimeout);
            set({ _keepAliveTimeout: null });
          }

          // Attempt reconnection if not intentionally closed
          if (event.code !== 1000 && currentState._reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            const delay = calculateReconnectDelay(currentState._reconnectAttempts);
            logger.log(
              `Reconnecting in ${delay}ms (attempt ${currentState._reconnectAttempts + 1})`
            );

            const timeout = setTimeout(() => {
              set({ _reconnectAttempts: currentState._reconnectAttempts + 1 });
              get().connect();
            }, delay);

            set({ _reconnectTimeout: timeout });
          }
        };

        set({ _ws: ws });
      } catch (error) {
        logger.error('Failed to connect:', error);
        set({ _isConnecting: false });
      }
    },

    /**
     * Disconnect WebSocket
     */
    disconnect: () => {
      const state = get();

      if (state._reconnectTimeout) {
        clearTimeout(state._reconnectTimeout);
      }

      if (state._keepAliveTimeout) {
        clearTimeout(state._keepAliveTimeout);
      }

      if (state._ws) {
        if (state._ws.readyState === WebSocket.OPEN) {
          state._ws.close(1000, 'Disconnect requested');
        }
      }

      set({
        isConnected: false,
        isConnectionAcknowledged: false,
        _ws: null,
        _reconnectTimeout: null,
        _keepAliveTimeout: null,
        _isConnecting: false,
      });
    },

    /**
     * Subscribe to a channel
     */
    subscribe: async (channel: string, subscriptionId: string, handler: SubscriptionHandler) => {
      const state = get();

      // Register handler
      const handlers = new Map(state._subscriptionHandlers);
      handlers.set(subscriptionId, handler);
      set({ _subscriptionHandlers: handlers });

      // Skip if already subscribed
      if (state._channelMap.has(subscriptionId)) {
        logger.log(`Already subscribed to: ${subscriptionId}`);
        return;
      }

      if (state._pendingSubscriptions.has(subscriptionId)) {
        logger.log(`Subscription pending for: ${subscriptionId}`);
        return;
      }

      // Store channel mapping for later re-subscription
      const channelMap = new Map(state._channelMap);
      channelMap.set(subscriptionId, channel);
      set({ _channelMap: channelMap });

      const ws = state._ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        logger.log('WebSocket not open, will subscribe when connected');
        return;
      }

      if (!state.isConnectionAcknowledged) {
        logger.log('Connection not acknowledged, will subscribe after ack');
        return;
      }

      // Get fresh access token (auto-refreshes if expired)
      let accessToken: string;
      try {
        accessToken = (await authService.getTokens()).accessToken;
      } catch (err) {
        logger.log('No auth token, cannot subscribe', err);
        return;
      }

      logger.log(`Subscribing to: ${channel} (id: ${subscriptionId})`);

      // Mark as pending
      const pending = new Set(state._pendingSubscriptions);
      pending.add(subscriptionId);
      set({ _pendingSubscriptions: pending });

      ws.send(
        JSON.stringify({
          type: 'subscribe',
          id: subscriptionId,
          channel,
          authorization: {
            Authorization: accessToken,
            host: state.httpHost,
          },
        })
      );
    },

    /**
     * Unsubscribe from a channel
     */
    unsubscribe: (subscriptionId: string) => {
      const state = get();

      // Remove handler
      const handlers = new Map(state._subscriptionHandlers);
      handlers.delete(subscriptionId);

      // Remove from channel map
      const channelMap = new Map(state._channelMap);
      channelMap.delete(subscriptionId);

      // Remove from pending set
      const pending = new Set(state._pendingSubscriptions);
      pending.delete(subscriptionId);

      set({
        _subscriptionHandlers: handlers,
        _channelMap: channelMap,
        _pendingSubscriptions: pending,
      });

      const ws = state._ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        logger.log(`Unsubscribing from: ${subscriptionId}`);
        ws.send(
          JSON.stringify({
            type: 'unsubscribe',
            id: subscriptionId,
          })
        );
      }
    },
  }))
);

/**
 * Hook to access connection state only (with shallow comparison)
 *
 * ## WHY: useShallow prevents infinite render loops
 *
 * Without useShallow, Zustand's selector returns a new object reference on every call:
 *   `{ isConnected, isConnectionAcknowledged }` - new object each time
 *
 * This causes React to think the state changed, triggering re-render,
 * which calls the selector again, creating an infinite loop.
 *
 * useShallow performs shallow comparison of the returned object's values,
 * so React only re-renders when actual values change, not just object references.
 *
 * Alternative solutions (not used):
 * - Select primitive values separately: requires multiple useAppSyncConnectionStore calls
 * - Use subscribeWithSelector: more complex setup for same result
 */
export function useAppSyncConnectionState() {
  return useAppSyncConnectionStore(
    useShallow((state) => ({
      isConnected: state.isConnected,
      isConnectionAcknowledged: state.isConnectionAcknowledged,
    }))
  );
}
