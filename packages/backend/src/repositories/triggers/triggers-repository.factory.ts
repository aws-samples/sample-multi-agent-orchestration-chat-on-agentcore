/**
 * Composition root for the triggers repository.
 *
 * Lives in the repositories/ layer (alongside the interface and the DynamoDB
 * implementation) so that ALL DynamoDB SDK access stays confined here — the
 * `no-restricted-imports` rule in eslint.config.mjs forbids the SDK everywhere
 * else in backend. The repository is deliberately `config`-free (client + table
 * name injected) so it stays unit/integration-testable against DynamoDB Local;
 * this factory is the single place that binds it to runtime configuration: it
 * builds the `DynamoDBClient` from `config` and memoises one instance for the
 * API routes.
 *
 * This is also the ONLY module that reaches into the implementation subtree
 * (`./dynamodb`) to pick a concrete repository. Everything else depends on the
 * `TriggersRepository` interface, so swapping the storage engine is a one-line
 * change here.
 *
 * NOTE: this `*-repository.factory.ts` is the deliberate exception to the
 * repositories-layer `config`-free rule (also enforced in eslint.config.mjs):
 * the repository/item/mapper modules must stay `config`-free, but the
 * composition root is exactly where config is allowed in.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { config } from '../../config/index.js';
import type { TriggersRepository } from './index.js';
import { DynamoDBTriggersRepository } from './dynamodb/index.js';

let instance: TriggersRepository | null = null;

/**
 * Get or create the env-bound TriggersRepository singleton.
 */
export function getTriggersRepository(): TriggersRepository {
  if (!instance) {
    instance = new DynamoDBTriggersRepository(
      new DynamoDBClient({ region: config.AWS_REGION }),
      config.TRIGGERS_TABLE_NAME
    );
  }
  return instance;
}
