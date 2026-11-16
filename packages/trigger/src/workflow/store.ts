import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
  workflowKeys,
  workflowTtl,
  type WorkflowRecord,
  type WorkflowStatus,
  type WorkflowStepState,
} from '@moca/tool-definitions';

export class WorkflowStore {
  constructor(
    private readonly client: DynamoDBClient,
    private readonly tableName: string
  ) {}

  static fromEnvironment(): WorkflowStore {
    const tableName = process.env.WORKFLOWS_TABLE_NAME;
    if (!tableName) throw new Error('WORKFLOWS_TABLE_NAME environment variable is required');
    return new WorkflowStore(new DynamoDBClient({ region: process.env.AWS_REGION }), tableName);
  }

  async get(userId: string, workflowId: string): Promise<WorkflowRecord | null> {
    const res = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: marshall({ PK: workflowKeys.pk(userId), SK: workflowKeys.header(workflowId) }),
        ConsistentRead: true,
      })
    );
    return res.Item ? (unmarshall(res.Item) as WorkflowRecord) : null;
  }

  async listSteps(userId: string, workflowId: string): Promise<WorkflowStepState[]> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: marshall({
          ':pk': workflowKeys.pk(userId),
          ':sk': workflowKeys.stepPrefix(workflowId),
        }),
        ConsistentRead: true,
      })
    );
    return (res.Items ?? []).map((i) => unmarshall(i) as WorkflowStepState);
  }

  /**
   * A cancelled step is final: writes still in flight from the main
   * execution (stopped mid-invocation) must not resurrect it.
   */
  async saveStep(userId: string, state: WorkflowStepState): Promise<void> {
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: marshall(
            {
              PK: workflowKeys.pk(userId),
              SK: workflowKeys.step(state.workflowId, state.stepId),
              ...state,
              ttl: workflowTtl(),
            },
            { removeUndefinedValues: true }
          ),
          ConditionExpression: 'attribute_not_exists(PK) OR #status <> :cancelled',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: marshall({ ':cancelled': 'cancelled' }),
        })
      );
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return;
      throw error;
    }
  }

  /**
   * Update the header status. A cancelled workflow is never moved back to
   * another status, so a late orchestrator write cannot resurrect it.
   */
  async setStatus(
    userId: string,
    workflowId: string,
    status: WorkflowStatus,
    fields: { result?: string; error?: string } = {}
  ): Promise<void> {
    const now = new Date().toISOString();
    const names: Record<string, string> = { '#status': 'status', '#updatedAt': 'updatedAt' };
    const values: Record<string, unknown> = {
      ':status': status,
      ':now': now,
      ':cancelled': 'cancelled',
    };
    const sets = ['#status = :status', '#updatedAt = :now'];
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      names['#completedAt'] = 'completedAt';
      sets.push('#completedAt = :now');
    }
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      names[`#${key}`] = key;
      values[`:${key}`] = value;
      sets.push(`#${key} = :${key}`);
    }
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: marshall({ PK: workflowKeys.pk(userId), SK: workflowKeys.header(workflowId) }),
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(PK) AND #status <> :cancelled',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: marshall(values),
        })
      );
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return;
      throw error;
    }
  }
}
