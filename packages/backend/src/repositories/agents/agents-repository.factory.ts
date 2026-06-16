/**
 * Composition root for the agents repository.
 *
 * Lives in the repositories/ layer (alongside the interface and the DynamoDB
 * implementation) so that ALL DynamoDB SDK access stays confined here — the
 * `no-restricted-imports` rule in eslint.config.mjs forbids the SDK everywhere
 * else in backend. This factory is the single place that binds the
 * `config`-free repository to runtime configuration: it builds the
 * `DynamoDBClient` from `config` and memoises one instance for the API routes.
 *
 * This is also the ONLY module that reaches into the implementation subtree
 * (`./dynamodb`) to pick a concrete repository. Everything else depends on the
 * `AgentsRepository` interface.
 *
 * NOTE: this `*-repository.factory.ts` is the deliberate exception to the
 * repositories-layer `config`-free rule (also enforced in eslint.config.mjs):
 * the repository/item/mapper modules must stay `config`-free for DynamoDB-Local
 * testability, but the composition root is exactly where config is allowed in.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { config } from '../../config/index.js';
import type { AgentsRepository } from './index.js';
import { DynamoDBAgentsRepository } from './dynamodb/index.js';

let instance: AgentsRepository | null = null;

/** Get or create the env-bound AgentsRepository singleton. */
export function getAgentsRepository(): AgentsRepository {
  if (!instance) {
    instance = new DynamoDBAgentsRepository(
      new DynamoDBClient({ region: config.AWS_REGION }),
      config.AGENTS_TABLE_NAME
    );
  }
  return instance;
}
