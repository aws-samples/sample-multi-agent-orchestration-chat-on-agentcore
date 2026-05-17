/**
 * Re-export barrel for session types.
 * Canonical definitions live in models/session-types.ts (L1 layer).
 * This file exists for backward-compatibility so that higher layers
 * (session, services, agent, handlers) can keep their existing imports.
 */
export type { SessionType, SessionConfig, SessionStorage } from '../../types/session-types.js';
