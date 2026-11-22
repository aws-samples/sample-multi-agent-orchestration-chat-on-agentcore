/**
 * Composition root for the usage repository (the one place that reads config).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { config } from '../../config/index.js';
import type { UsageRepository } from './index.js';
import { DynamoDBUsageRepository } from './dynamodb/index.js';

let instance: UsageRepository | null = null;

export function getUsageRepository(): UsageRepository {
  if (!instance) {
    instance = new DynamoDBUsageRepository(
      new DynamoDBClient({ region: config.AWS_REGION }),
      config.USAGE_TABLE_NAME
    );
  }
  return instance;
}
