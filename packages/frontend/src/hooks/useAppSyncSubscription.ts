/**
 * AppSync Subscription Hook
 *
 * Hook to subscribe to a channel on the shared AppSync Events WebSocket connection.
 */
import { useEffect, useRef } from 'react';
import { useAppSyncConnectionStore } from '../stores/appsyncConnectionStore';

/**
 * Hook to subscribe to a channel on the shared connection.
 *
 * @param channel - The channel to subscribe to (e.g., '/sessions/{userId}')
 * @param subscriptionId - Unique ID for this subscription
 * @param handler - Callback to handle incoming events
 * @param enabled - Whether the subscription should be active
 * @param onSubscribed - Called on every subscribe_success, including after a
 *   reconnect. AppSync Events does not replay, so use it to catch up.
 *
 * ## Usage Pattern
 *
 * ```tsx
 * useAppSyncSubscription(
 *   `/sessions/${userId}`,           // channel path
 *   `session-events-${userId}`,      // unique subscription ID
 *   (event) => handleEvent(event),   // event handler
 *   !!userId                         // enabled condition
 * );
 * ```
 */
export function useAppSyncSubscription(
  channel: string | null,
  subscriptionId: string | null,
  handler: (event: string) => void,
  enabled: boolean = true,
  onSubscribed?: () => void
) {
  const onSubscribedRef = useRef(onSubscribed);
  useEffect(() => {
    onSubscribedRef.current = onSubscribed;
  });

  const subscribe = useAppSyncConnectionStore((state) => state.subscribe);
  const unsubscribe = useAppSyncConnectionStore((state) => state.unsubscribe);

  useEffect(() => {
    if (!enabled || !channel || !subscriptionId) {
      return;
    }

    // Subscribe to channel
    // Note: subscription is stored in channelMap and will be sent when connection is acknowledged
    subscribe(channel, subscriptionId, handler, () => onSubscribedRef.current?.());

    // Cleanup: unsubscribe when channel changes or component unmounts
    return () => {
      unsubscribe(subscriptionId);
    };
    /**
     * WHY: Intentionally excluding isConnectionAcknowledged from dependencies
     *
     * If we included isConnectionAcknowledged in the dependency array:
     * 1. useEffect would re-run when connection is acknowledged
     * 2. This would call subscribe() again for the same subscriptionId
     * 3. AppSync would return DuplicatedOperationError
     *
     * Instead, the store handles the timing internally:
     * - subscribe() stores the channel in _channelMap immediately
     * - When connection_ack arrives, store re-subscribes from _channelMap
     * - This ensures subscriptions are sent only after connection is ready
     *
     * The handler callback is also excluded because:
     * - Including it would cause re-subscription on every render (new function reference)
     * - The store updates the handler in _subscriptionHandlers without re-subscribing
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, subscriptionId, enabled]);
}
