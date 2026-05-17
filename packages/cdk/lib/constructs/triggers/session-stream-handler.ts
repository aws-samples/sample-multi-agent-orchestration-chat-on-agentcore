/**
 * Session Stream Handler Lambda
 *
 * This construct creates a Lambda function that processes DynamoDB Streams
 * from the Sessions table and publishes events to AppSync Events API.
 */
import * as cdk from 'aws-cdk-lib';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { AppSyncEvents } from '../api';
import * as path from 'path';

export interface SessionStreamHandlerProps {
  /**
   * The DynamoDB table with streams enabled
   */
  readonly sessionsTable: dynamodb.ITable;

  /**
   * The AppSync Events construct
   */
  readonly appsyncEvents: AppSyncEvents;

  /**
   * Lambda function timeout (default: 30 seconds)
   */
  readonly timeout?: cdk.Duration;

  /**
   * CloudWatch Logs retention (default: 1 week)
   */
  readonly logRetention?: logs.RetentionDays;
}

/**
 * Lambda function that handles DynamoDB Streams and publishes to AppSync Events
 */
export class SessionStreamHandler extends Construct {
  /**
   * The Lambda function
   */
  public readonly handler: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: SessionStreamHandlerProps) {
    super(scope, id);

    // Create CloudWatch Log Group (explicit so stack deletion cleans it up)
    const logGroup = new logs.LogGroup(this, 'HandlerLogGroup', {
      retention: props.logRetention || logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create Lambda function using NodejsFunction for bundling
    this.handler = new nodejs.NodejsFunction(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      // ARM64 (Graviton2) — pure Node.js + AWS SDK workload, no native bindings.
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '../../../../session-stream-handler/src/index.ts'),
      handler: 'handler',
      environment: {
        APPSYNC_HTTP_ENDPOINT: props.appsyncEvents.httpEndpoint,
      },
      timeout: props.timeout || cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup,
      description: 'Processes DynamoDB Streams and publishes to AppSync Events',
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'es2022',
        // No `externalModules` entry: Node 22 Lambda runtime does not ship
        // `aws-sdk` v2 anymore, and our code only uses AWS SDK v3
        // (`@aws-sdk/*`), which esbuild bundles alongside the handler.
      },
    });

    // Add DynamoDB Streams event source
    this.handler.addEventSource(
      new lambdaEventSources.DynamoEventSource(props.sessionsTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        retryAttempts: 3,
        reportBatchItemFailures: true,
      })
    );

    // Grant permission to publish to AppSync Events
    props.appsyncEvents.grantPublish(this.handler);

    // Grant stream read access
    props.sessionsTable.grantStreamRead(this.handler);

    // Add tags
    cdk.Tags.of(this.handler).add('Component', 'RealTimeEvents');
    cdk.Tags.of(this.handler).add('Purpose', 'SessionStreamHandler');
  }
}
