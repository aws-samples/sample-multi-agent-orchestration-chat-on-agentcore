/**
 * AppSync Events API for real-time session updates
 *
 * This construct creates an AppSync Event API that enables real-time
 * WebSocket communication between the backend and frontend.
 */
import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface AppSyncEventsProps {
  /**
   * Name for the AppSync Event API
   */
  readonly apiName: string;

  /**
   * Cognito User Pool for authentication
   */
  readonly userPool: cognito.IUserPool;
}

/**
 * AppSync Events API construct for real-time updates
 */
export class AppSyncEvents extends Construct {
  /**
   * The AppSync Event API
   */
  public readonly api: appsync.CfnApi;

  /**
   * The channel namespace for sessions
   */
  public readonly channelNamespace: appsync.CfnChannelNamespace;

  /**
   * The channel namespace for messages
   */
  public readonly messagesNamespace: appsync.CfnChannelNamespace;

  /**
   * HTTP endpoint for publishing events
   */
  public readonly httpEndpoint: string;

  /**
   * Realtime WebSocket endpoint for subscriptions
   */
  public readonly realtimeEndpoint: string;

  /**
   * The API ID
   */
  public readonly apiId: string;

  constructor(scope: Construct, id: string, props: AppSyncEventsProps) {
    super(scope, id);

    const region = cdk.Stack.of(this).region;

    // Create AppSync Event API
    this.api = new appsync.CfnApi(this, 'EventApi', {
      name: props.apiName,
      eventConfig: {
        authProviders: [
          {
            authType: 'AMAZON_COGNITO_USER_POOLS',
            cognitoConfig: {
              userPoolId: props.userPool.userPoolId,
              awsRegion: region,
            },
          },
          {
            authType: 'AWS_IAM',
          },
        ],
        // Connection auth: Cognito for frontend WebSocket connections
        connectionAuthModes: [{ authType: 'AMAZON_COGNITO_USER_POOLS' }],
        // Publish auth: IAM for Lambda to publish events
        defaultPublishAuthModes: [{ authType: 'AWS_IAM' }],
        // Subscribe auth: Cognito for frontend subscriptions
        defaultSubscribeAuthModes: [{ authType: 'AMAZON_COGNITO_USER_POOLS' }],
      },
    });

    this.apiId = this.api.attrApiId;

    // Create channel namespace for sessions
    this.channelNamespace = new appsync.CfnChannelNamespace(this, 'SessionsNamespace', {
      apiId: this.apiId,
      name: 'sessions',
    });

    // Create channel namespace for messages (real-time message events)
    this.messagesNamespace = new appsync.CfnChannelNamespace(this, 'MessagesNamespace', {
      apiId: this.apiId,
      name: 'messages',
    });

    // Get DNS endpoints using CloudFormation intrinsic functions
    // Note: AppSync Events assigns DNS hostnames different from API ID
    // Use Fn.getAtt to retrieve the actual DNS endpoints
    const httpDns = cdk.Fn.getAtt(this.api.logicalId, 'Dns.Http');
    const realtimeDns = cdk.Fn.getAtt(this.api.logicalId, 'Dns.Realtime');

    // Build endpoints using DNS attributes
    // AppSync Events uses /event path for HTTP and /event/realtime for WebSocket
    this.httpEndpoint = cdk.Fn.join('', ['https://', httpDns.toString(), '/event']);
    this.realtimeEndpoint = cdk.Fn.join('', ['wss://', realtimeDns.toString(), '/event/realtime']);

    // Add tags
    cdk.Tags.of(this.api).add('Component', 'RealTimeEvents');
    cdk.Tags.of(this.api).add('Purpose', 'SessionUpdates');

    // CloudFormation Outputs
    new cdk.CfnOutput(this, 'EventApiId', {
      value: this.apiId,
      description: 'AppSync Event API ID',
      exportName: `${cdk.Stack.of(this).stackName}-EventApiId`,
    });

    new cdk.CfnOutput(this, 'EventApiHttpEndpoint', {
      value: this.httpEndpoint,
      description: 'AppSync Event API HTTP endpoint for publishing',
      exportName: `${cdk.Stack.of(this).stackName}-EventApiHttpEndpoint`,
    });

    new cdk.CfnOutput(this, 'EventApiRealtimeEndpoint', {
      value: this.realtimeEndpoint,
      description: 'AppSync Event API WebSocket endpoint for subscriptions',
      exportName: `${cdk.Stack.of(this).stackName}-EventApiRealtimeEndpoint`,
    });
  }

  /**
   * Grant permission to publish events to a principal
   */
  public grantPublish(grantee: iam.IGrantable): iam.Grant {
    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['appsync:EventPublish'],
      resourceArns: [`${this.api.attrApiArn}/*`],
    });
  }

  /**
   * Grant permission to subscribe to events to a principal
   */
  public grantSubscribe(grantee: iam.IGrantable): iam.Grant {
    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['appsync:EventSubscribe'],
      resourceArns: [`${this.api.attrApiArn}/*`],
    });
  }

  /**
   * Grant permission to connect to the API
   */
  public grantConnect(grantee: iam.IGrantable): iam.Grant {
    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['appsync:EventConnect'],
      resourceArns: [`${this.api.attrApiArn}/*`],
    });
  }
}
