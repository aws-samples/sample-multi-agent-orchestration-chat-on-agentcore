import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface WorkflowsTableProps {
  readonly tableNamePrefix: string;
  readonly removalPolicy?: cdk.RemovalPolicy;
}

/**
 * Multi-agent workflow state. PK `USER#{userId}`; SK `WORKFLOW#{id}` for the
 * header and `WFSTEP#{id}#{stepId}` per step. Items expire via `ttl`.
 */
export class WorkflowsTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: WorkflowsTableProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, 'Table', {
      tableName: `${props.tableNamePrefix}-workflows`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'ttl',
    });

    cdk.Tags.of(this.table).add('Component', 'Workflows');
  }
}
