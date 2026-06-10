import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface TriggersTableProps {
  /**
   * Table name prefix
   */
  readonly tableNamePrefix: string;

  /**
   * Removal policy for the table (default: RETAIN)
   */
  readonly removalPolicy?: cdk.RemovalPolicy;

  /**
   * Point-in-time recovery enabled (default: true)
   */
  readonly pointInTimeRecovery?: boolean;
}

/**
 * DynamoDB table for storing triggers and execution history
 *
 * Table structure:
 * - PK: TRIGGER#{userId} or TRIGGER#{triggerId}
 * - SK: TRIGGER#{triggerId} or EXECUTION#{executionId}
 *
 * GSI1 (query triggers by type):
 * - GSI1PK: TYPE#{type}
 * - GSI1SK: USER#{userId}#{triggerId}
 *
 * GSI2 (query triggers by eventSourceId — event subscription model):
 * - GSI2PK: EVENTSOURCE#{eventSourceId}
 * - GSI2SK: USER#{userId}#TRIGGER#{triggerId}
 *
 * TTL: enabled on 'ttl' attribute for automatic cleanup of execution history
 */
export class TriggersTable extends Construct {
  /**
   * The DynamoDB table
   */
  public readonly table: dynamodb.Table;

  /**
   * The table name
   */
  public readonly tableName: string;

  /**
   * The table ARN
   */
  public readonly tableArn: string;

  constructor(scope: Construct, id: string, props: TriggersTableProps) {
    super(scope, id);

    // Create DynamoDB table for triggers and execution history
    this.table = new dynamodb.Table(this, 'Table', {
      tableName: `${props.tableNamePrefix}-triggers`,
      partitionKey: {
        name: 'PK',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'SK',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: props.removalPolicy || cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: props.pointInTimeRecovery ?? true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      // Enable TTL for automatic cleanup of execution history (30 days)
      timeToLiveAttribute: 'ttl',
    });

    // Add GSI1 for querying triggers by type
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: {
        name: 'GSI1PK',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'GSI1SK',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Add GSI2 for querying triggers by eventSourceId (event subscription model)
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: {
        name: 'GSI2PK',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'GSI2SK',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.tableName = this.table.tableName;
    this.tableArn = this.table.tableArn;

    // Add tags
    cdk.Tags.of(this.table).add('Component', 'TriggerManagement');
    cdk.Tags.of(this.table).add('Purpose', 'EventDrivenAgentTriggers');

    // Note: CfnOutput is defined in agentcore-stack.ts to match setup-env.ts expectations
  }

  /**
   * Grant read permissions to a principal
   */
  public grantRead(grantee: cdk.aws_iam.IGrantable): void {
    this.table.grantReadData(grantee);
  }

  /**
   * Grant write permissions to a principal
   */
  public grantWrite(grantee: cdk.aws_iam.IGrantable): void {
    this.table.grantWriteData(grantee);
  }

  /**
   * Grant read/write permissions to a principal
   */
  public grantReadWrite(grantee: cdk.aws_iam.IGrantable): void {
    this.table.grantReadWriteData(grantee);
  }
}
