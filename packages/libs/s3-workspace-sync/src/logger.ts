import type { SyncLogger } from './types.js';

/**
 * Default console-based logger used when no custom logger is provided.
 * Prefixes all messages with `[S3_WORKSPACE_SYNC]` and an ISO timestamp.
 */
export function createDefaultLogger(): SyncLogger {
  const format = (...args: unknown[]): unknown[] =>
    args.map((arg) => (typeof arg === 'object' && arg !== null ? JSON.stringify(arg) : arg));

  return {
    debug: (message, ...args) => {
      console.debug('[S3_WORKSPACE_SYNC]', new Date().toISOString(), message, ...format(...args));
    },
    info: (message, ...args) => {
      console.log('[S3_WORKSPACE_SYNC]', new Date().toISOString(), message, ...format(...args));
    },
    warn: (message, ...args) => {
      console.warn('[S3_WORKSPACE_SYNC]', new Date().toISOString(), message, ...format(...args));
    },
    error: (message, ...args) => {
      console.error('[S3_WORKSPACE_SYNC]', new Date().toISOString(), message, ...format(...args));
    },
  };
}
