/**
 * Triggers repository — public entry point.
 *
 * Import everything you need to USE triggers from here:
 *   - the `TriggersRepository` behaviour contract (interface),
 *   - the domain types / inputs / results,
 *   - the `MAX_TRIGGERS_PER_USER` limit and `TriggerLimitExceededError`.
 *
 * The DynamoDB implementation lives under `./dynamodb/` and is NOT re-exported
 * here: application code depends on the interface, and only the composition
 * root (`services/triggers-repository.factory.ts`) reaches into `./dynamodb/`
 * to construct a concrete instance. That boundary is what lets you read this
 * one barrel — never the implementation — to work with triggers.
 */

// The behaviour contract and its method input/output types.
export type {
  TriggersRepository,
  CreateTriggerInput,
  UpdateTriggerInput,
  ListTriggersOptions,
  ListTriggersResult,
  GetExecutionsResult,
} from './triggers-repository.js';

// The domain model: what a trigger IS. `export *` keeps the model surface in
// lockstep with `types.ts` so a newly-added model type is visible here without
// a manual edit. Operation types are listed explicitly above because they live
// with the interface, not in the model file.
export * from './types.js';
