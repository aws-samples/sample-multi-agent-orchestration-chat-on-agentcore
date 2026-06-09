/**
 * Composition root for the sessions repository.
 *
 * Mirrors triggers-repository.factory.ts: the repository is `config`-free for
 * testability, and this factory is the single place that binds it to runtime
 * configuration (DynamoDBClient + table name from `config`) and memoises one
 * instance for the API routes.
 *
 * This is also the ONLY module that reaches into the implementation subtree
 * (`repositories/sessions/dynamodb`) to pick a concrete repository. Everything
 * else depends on the `SessionsRepository` interface, so swapping the storage
 * engine is a one-line change here.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { config } from '../config/index.js';
import type { SessionsRepository } from '../repositories/sessions/index.js';
import { DynamoDBSessionsRepository } from '../repositories/sessions/dynamodb/index.js';

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
