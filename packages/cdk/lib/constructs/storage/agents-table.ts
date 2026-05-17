import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface AgentsTableProps {
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
 * DynamoDB table for storing user agents
 */
export class AgentsTable extends Construct {
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

  constructor(scope: Construct, id: string, props: AgentsTableProps) {
    super(scope, id);

    // Create DynamoDB table for agents
    this.table = new dynamodb.Table(this, 'Table', {
      tableName: `${props.tableNamePrefix}-agents`,
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'agentId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: props.removalPolicy || cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: props.pointInTimeRecovery ?? true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // Add GSI for querying shared agents
    this.table.addGlobalSecondaryIndex({
      indexName: 'isShared-createdAt-index',
      partitionKey: {
        name: 'isShared',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.tableName = this.table.tableName;
    this.tableArn = this.table.tableArn;

    // Add tags
    cdk.Tags.of(this.table).add('Component', 'AgentManagement');
    cdk.Tags.of(this.table).add('Purpose', 'UserAgentStorage');
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
