/**
 * AppSync Events Utility Functions
 *
 * Common utilities for AppSync Events WebSocket connections
 */

/**
 * Encode object to Base64URL format (required for AppSync Events subprotocol)
 * Base64URL: replaces + with -, / with _, and removes = padding
 */
export function getBase64URLEncoded(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build HTTP host from AppSync realtime endpoint
 *
 * Endpoint format: wss://xxx.appsync-realtime-api.region.amazonaws.com/event/realtime
 * HTTP host format: xxx.appsync-api.region.amazonaws.com
 */
export function buildHttpHostFromEndpoint(endpoint: string): string {
  const realtimeHost = new URL(endpoint.replace('wss://', 'https://')).hostname;
  return realtimeHost.replace('.appsync-realtime-api.', '.appsync-api.');
}

/**
 * Create authorization protocol string for WebSocket subprotocol
 */
export function createAuthProtocol(token: string, httpHost: string): string {
  const authorization = {
    Authorization: token,
    host: httpHost,
  };
  return `header-${getBase64URLEncoded(authorization)}`;
}

/**
 * Calculate reconnection delay with exponential backoff
 *
 * @param attempt - Current reconnection attempt number (0-based)
 * @param maxDelay - Maximum delay in milliseconds (default: 30000)
 * @returns Delay in milliseconds
 */
export function calculateReconnectDelay(attempt: number, maxDelay = 30000): number {
  return Math.min(1000 * Math.pow(2, attempt), maxDelay);
}
