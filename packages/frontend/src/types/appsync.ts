/**
 * AppSync Events Type Definitions
 *
 * Common types for AppSync Events WebSocket connections
 */

/**
 * AppSync Events WebSocket message types
 */
export interface AppSyncMessage {
  type: AppSyncMessageType;
  id?: string;
  event?: string;
}

/**
 * AppSync Events message type
 */
export type AppSyncMessageType =
  | 'connection_ack'
  | 'subscribe_success'
  | 'subscribe_error'
  | 'data'
  | 'ka' // keep-alive
  | 'error';

/**
 * WebSocket connection state
 */
export interface WebSocketConnectionState {
  isConnected: boolean;
  reconnectAttempts: number;
  lastError?: string;
}

/**
 * AppSync subscription config
 */
export interface AppSyncSubscriptionConfig {
  channel: string;
  subscriptionId: string;
}
