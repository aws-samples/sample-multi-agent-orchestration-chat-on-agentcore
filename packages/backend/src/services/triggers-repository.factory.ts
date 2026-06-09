/**
 * Composition root for the triggers repository.
 *
 * The repository is deliberately `config`-free (client + table name injected)
 * so it stays unit/integration-testable against DynamoDB Local. This factory is
 * the single place that binds it to runtime configuration: it builds the
 * `DynamoDBClient` from `config` and memoises one repository instance for the
 * API routes. Keeping this concern here — rather than in the repository — is
 * what prevents `config`'s env validation / `process.exit` from leaking into
 * the testable data-access layer.
 *
 * This is also the ONLY module that reaches into the implementation subtree
 * (`repositories/triggers/dynamodb`) to pick a concrete repository. Everything
 * else depends on the `TriggersRepository` interface, so swapping the storage
 * engine is a one-line change here.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { config } from '../config/index.js';
import type { TriggersRepository } from '../repositories/triggers/index.js';
import { DynamoDBTriggersRepository } from '../repositories/triggers/dynamodb/index.js';

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
