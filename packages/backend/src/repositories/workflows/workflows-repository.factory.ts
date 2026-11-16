import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { config } from '../../config/index.js';
import { WorkflowsRepository } from './workflows-repository.js';

let instance: WorkflowsRepository | undefined;

export function getWorkflowsRepository(): WorkflowsRepository {
  instance ??= new WorkflowsRepository(
    new DynamoDBClient({ region: config.AWS_REGION }),
    config.WORKFLOWS_TABLE_NAME
  );
  return instance;
}
