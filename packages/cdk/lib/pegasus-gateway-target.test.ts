import * as cdk from 'aws-cdk-lib';
import { jest, test, expect } from '@jest/globals';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AgentCoreGatewayTargetStack } from './agentcore-gateway-target-stack';
import { getEnvironmentConfig } from '../config';

jest.mock('../config/environments', () => ({
  BASE_PREFIX: 'moca',
  environments: { default: { cognitoDomainPrefix: 'moca-test' } },
}));

// Infrastructure assertions should not depend on Docker or build esbuild assets.
jest.mock('aws-cdk-lib/aws-lambda-nodejs', () => {
  const lambda =
    jest.requireActual<typeof import('aws-cdk-lib/aws-lambda')>('aws-cdk-lib/aws-lambda');
  return {
    NodejsFunction: class extends lambda.Function {
      constructor(scope: cdk.Stack, id: string, props: Record<string, unknown>) {
        super(scope, id, {
          runtime: lambda.Runtime.NODEJS_22_X,
          handler: 'index.handler',
          ...props,
          code: lambda.Code.fromInline('exports.handler = async () => {};'),
        });
      }
    },
  };
});

test('Pegasus target scopes model and storage access and forwards identity/workspace headers', () => {
  const stack = new AgentCoreGatewayTargetStack(new cdk.App(), 'Targets', {
    env: { account: '111122223333', region: 'us-east-1' },
    envConfig: { ...getEnvironmentConfig('default'), tavilyApiKeySecretName: undefined },
    coreStackName: 'Core',
  });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::Lambda::Function', {
    Description: 'Video analysis with TwelveLabs Pegasus 1.5',
    Timeout: 900,
    Environment: {
      Variables: Match.objectLike({
        PEGASUS_REGION: 'us-east-1',
        USER_STORAGE_BUCKET_OWNER: '111122223333',
        USER_STORAGE_BUCKET_NAME: { 'Fn::ImportValue': 'Core-UserStorageBucketName' },
      }),
    },
  });
  const policy = Object.entries(template.findResources('AWS::IAM::Policy')).find(([id]) =>
    id.includes('PegasusToolsTarget')
  )?.[1];
  expect(policy).toBeDefined();
  const statements = policy!.Properties.PolicyDocument.Statement;
  const bedrock = statements.find((s: { Action: string }) => s.Action === 'bedrock:InvokeModel');
  expect(bedrock.Resource).toEqual(
    [
      ':bedrock:us-east-1:111122223333:inference-profile/global.twelvelabs.pegasus-1-5-v1:0',
      ':bedrock:us-east-1:111122223333:inference-profile/us.twelvelabs.pegasus-1-5-v1:0',
      ':bedrock:*::foundation-model/twelvelabs.pegasus-1-5-v1:0',
    ].map((suffix) => ({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, suffix]] }))
  );
  const read = statements.find((s: { Action: string }) => s.Action === 's3:GetObject');
  expect(read.Resource).toEqual({
    'Fn::Join': [
      '',
      [
        'arn:',
        { Ref: 'AWS::Partition' },
        ':s3:::',
        { 'Fn::ImportValue': 'Core-UserStorageBucketName' },
        '/users/*',
      ],
    ],
  });
  expect(JSON.stringify(statements)).not.toContain('s3:PutObject');
  expect(JSON.stringify(statements)).not.toContain('bedrock:InvokeModelWithResponseStream');
  template.hasResourceProperties(
    'AWS::BedrockAgentCore::GatewayTarget',
    Match.objectLike({
      Name: 'pegasus-tools',
      MetadataConfiguration: {
        AllowedRequestHeaders: [
          'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token',
          'x-storage-path',
        ],
      },
    })
  );
});
