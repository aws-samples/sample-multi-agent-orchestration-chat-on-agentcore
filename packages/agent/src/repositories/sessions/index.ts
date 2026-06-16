/**
 * Sessions repository — public entry point.
 *
 * Import everything you need to USE sessions from here:
 *   - the `SessionsRepository` behaviour contract (interface),
 *   - the operation types (`CreateSessionOptions`, `SessionListResult`),
 *   - the domain model (`SessionType`, `SessionData`, `SessionSummary`).
 *
 * The DynamoDB implementation lives under `./dynamodb/` and is NOT re-exported
 * here: the composition layer (`services/sessions-service.ts`) reaches into
 * `./dynamodb/` to construct a concrete instance per user, and everything else
 * depends only on the interface.
 */

// The behaviour contract and its operation input/output types.
export type {
  SessionsRepository,
  CreateSessionOptions,
  SessionListResult,
} from './sessions-repository.js';

// The domain model: what a session IS.
export type { SessionType, SessionData, SessionSummary } from './types.js';
