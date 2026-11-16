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
