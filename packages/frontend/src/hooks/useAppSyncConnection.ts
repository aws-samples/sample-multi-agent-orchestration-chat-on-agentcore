/**
 * AppSync Connection Hook
 *
 * Hook to manage the shared AppSync Events WebSocket connection.
 * Should be called once at the app level to initialize the connection.
 *
 * ## Architecture Overview
 *
 * - useAppSyncConnection() - Initialize the shared connection (call once in App.tsx)
 * - useAppSyncSubscription() - Subscribe to channels (exported from appsyncConnectionStore)
 *
 * The shared connection is managed by appsyncConnectionStore, which handles:
 * - Single WebSocket connection for all subscriptions
 * - Automatic reconnection with exponential backoff
 * - Re-subscription after reconnection
 */
import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import {
  useAppSyncConnectionStore,
  useAppSyncConnectionState,
} from '../stores/appsyncConnectionStore';

/**
 * Initialize and manage the shared AppSync WebSocket connection.
 *
 * This hook should be called once at the app level (e.g., in App.tsx or a layout component).
 * It will automatically connect when the user is authenticated and disconnect on logout.
 *
 * @returns Connection state (isConnected, isConnectionAcknowledged)
 */
export function useAppSyncConnection() {
  const user = useAuthStore((state) => state.user);
  const connect = useAppSyncConnectionStore((state) => state.connect);
  const disconnect = useAppSyncConnectionStore((state) => state.disconnect);
  const connectionState = useAppSyncConnectionState();

  // Connect when authenticated, disconnect on logout
  useEffect(() => {
    if (user?.userId) {
      connect();
    } else {
      // User logged out or not authenticated
      disconnect();
    }

    /**
     * WHY: Empty cleanup function instead of disconnect()
     *
     * We intentionally don't call disconnect() here because:
     * 1. React StrictMode mounts/unmounts components twice in development
     * 2. If we disconnect on unmount, the second mount would reconnect immediately
     * 3. This would cause unnecessary connection churn (disconnect → reconnect)
     *
     * Instead, disconnect is triggered when user state becomes null (logout),
     * which is handled by the if/else block above.
     */
    return () => {};
  }, [user?.userId, connect, disconnect]);

  return connectionState;
}
