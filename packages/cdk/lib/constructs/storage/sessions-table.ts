import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface SessionsTableProps {
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

  /**
   * Enable DynamoDB Streams for real-time updates (default: false)
   */
  readonly enableStreams?: boolean;
}

/**
 * DynamoDB table for storing user sessions
 */
export class SessionsTable extends Construct {
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

  /**
   * The table stream ARN (if streams enabled)
   */
  public readonly tableStreamArn?: string;

  constructor(scope: Construct, id: string, props: SessionsTableProps) {
    super(scope, id);

    // Create DynamoDB table for sessions
    this.table = new dynamodb.Table(this, 'Table', {
      tableName: `${props.tableNamePrefix}-sessions`,
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'sessionId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: props.removalPolicy || cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: props.pointInTimeRecovery ?? true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      // Enable streams for real-time updates if requested
      stream: props.enableStreams ? dynamodb.StreamViewType.NEW_AND_OLD_IMAGES : undefined,
    });

    // Add GSI for querying sessions by updatedAt (newest first)
    this.table.addGlobalSecondaryIndex({
      indexName: 'userId-updatedAt-index',
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'updatedAt',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.tableName = this.table.tableName;
    this.tableArn = this.table.tableArn;
    this.tableStreamArn = this.table.tableStreamArn;

    // Add tags
    cdk.Tags.of(this.table).add('Component', 'SessionManagement');
    cdk.Tags.of(this.table).add('Purpose', 'UserSessionStorage');
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
