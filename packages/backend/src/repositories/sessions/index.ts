/**
 * Sessions repository — public entry point.
 *
 * Import everything you need to USE sessions from here:
 *   - the `SessionsRepository` behaviour contract (interface),
 *   - the domain types (`SessionData`, `SessionSummary`, `SessionType`),
 *   - the `SessionListResult` method output shape.
 *
 * The DynamoDB implementation lives under `./dynamodb/` and is NOT re-exported
 * here: application code depends on the interface, and only the composition
 * root (`./sessions-repository.factory.ts`) reaches into `./dynamodb/`
 * to construct a concrete instance.
 */

// The behaviour contract and its method output types.
export type { SessionsRepository, SessionListResult } from './sessions-repository.js';

// The domain model: what a session IS. `export *` keeps the model surface in
// lockstep with `types.ts`.
export * from './types.js';
