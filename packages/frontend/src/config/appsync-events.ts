/**
 * AppSync Events Configuration
 *
 * Configuration for real-time session updates via AppSync Events API
 */

/**
 * AppSync Events endpoint configuration
 * These values are set via environment variables from CDK outputs
 */
export const appsyncEventsConfig = {
  /**
   * WebSocket endpoint for real-time subscriptions
   * Format: wss://{apiId}.appsync-realtime-api.{region}.amazonaws.com
   */
  realtimeEndpoint: import.meta.env.VITE_APPSYNC_EVENTS_ENDPOINT || '',

  /**
   * HTTP endpoint for publishing events (used by backend)
   */
  httpEndpoint: import.meta.env.VITE_APPSYNC_EVENTS_HTTP_ENDPOINT || '',

  /**
   * AWS Region
   */
  region: import.meta.env.VITE_AWS_REGION || 'us-east-1',

  /**
   * Check if AppSync Events is configured
   */
  get isConfigured(): boolean {
    return !!this.realtimeEndpoint;
  },
};
