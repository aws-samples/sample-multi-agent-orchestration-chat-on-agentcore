/**
 * Composition root for the sessions repository.
 *
 * Mirrors triggers-repository.factory.ts: lives in the repositories/ layer so
 * ALL DynamoDB SDK access stays confined here (enforced by `no-restricted-imports`
 * in eslint.config.mjs). The repository is `config`-free for testability, and
 * this factory is the single place that binds it to runtime configuration
 * (DynamoDBClient + table name from `config`) and memoises one instance for the
 * API routes.
 *
 * This is also the ONLY module that reaches into the implementation subtree
 * (`./dynamodb`) to pick a concrete repository. Everything else depends on the
 * `SessionsRepository` interface, so swapping the storage engine is a one-line
 * change here.
 *
 * NOTE: this `*-repository.factory.ts` is the deliberate exception to the
 * repositories-layer `config`-free rule (also enforced in eslint.config.mjs):
 * the repository/item/mapper modules must stay `config`-free, but the
 * composition root is exactly where config is allowed in.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { config } from '../../config/index.js';
import type { SessionsRepository } from './index.js';
import { DynamoDBSessionsRepository } from './dynamodb/index.js';

let instance: SessionsRepository | null = null;

/**
 * Get or create the env-bound SessionsRepository singleton.
 */
export function getSessionsRepository(): SessionsRepository {
  if (!instance) {
    instance = new DynamoDBSessionsRepository(
      new DynamoDBClient({ region: config.AWS_REGION }),
      config.SESSIONS_TABLE_NAME
    );
  }
  return instance;
}
