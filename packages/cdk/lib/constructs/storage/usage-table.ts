import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface UsageTableProps {
  readonly tableNamePrefix: string;
  readonly removalPolicy?: cdk.RemovalPolicy;
}

/**
 * Monthly token usage per user and model. PK `userId` (User Pool sub), SK
 * `M#YYYY-MM#<modelKey>`. Written ONLY by the Backend API role: neither the
 * Runtime execution role nor the Identity Pool role may touch it, or users
 * could lower their own usage (see docs/adr/token-usage-limits.md).
 */
export class UsageTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: UsageTableProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, 'Table', {
      tableName: `${props.tableNamePrefix}-usage`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'ttl',
    });

    cdk.Tags.of(this.table).add('Component', 'Usage');
  }
}
