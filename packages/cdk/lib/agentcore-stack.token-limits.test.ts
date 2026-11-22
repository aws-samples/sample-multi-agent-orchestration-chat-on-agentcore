/**
 * Whole-stack synth with `tokenLimits` configured. CI's `synth` job runs on
 * the pr-0 config, which has no tokenLimits, so without this test the usage
 * table, its IAM and the Cognito groups would never be synthesized — or
 * cdk-nag checked — before a real deploy.
 */

import { describe, expect, it, jest } from '@jest/globals';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AgentCoreStack } from './agentcore-stack';
import { getEnvironmentConfig } from '../config';

// Deploy-time builds (container image, frontend) hash and build the repo;
// irrelevant to the resources asserted here.
jest.mock('@cdklabs/deploy-time-build', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Construct } = require('constructs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ecr = require('aws-cdk-lib/aws-ecr');
  class ContainerImageBuild extends Construct {
    repository: unknown;
    imageTag = 'test';
    constructor(scope: unknown, id: string) {
      super(scope, id);
      this.repository = new ecr.Repository(this, 'Repo');
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const iam = require('aws-cdk-lib/aws-iam');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const s3 = require('aws-cdk-lib/aws-s3');
  class NodejsBuild extends Construct {
    grantPrincipal: unknown;
    constructor(scope: unknown, id: string) {
      super(scope, id);
      this.grantPrincipal = new iam.Role(this, 'Role', {
        assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      });
      // The stack adds cdk-nag suppressions on the real construct's cache bucket.
      new s3.Bucket(this, 'CacheBucket', { enforceSSL: true });
    }
  }
  return { ContainerImageBuild, NodejsBuild, CacheType: { NONE: 'NONE' } };
});

jest.setTimeout(180_000);

function synth(): { template: Template; stack: cdk.Stack } {
  // Skip esbuild bundling of every Lambda in the stack.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  cdk.Aspects.of(app).add(new AwsSolutionsChecks());
  const envConfig = {
    ...getEnvironmentConfig('pr-0'),
    tokenLimits: {
      limits: { default: { input: 100_000_000, output: 2_000_000 } },
      groups: { 'limit-test': { default: { input: 1, output: 1 } }, 営業: 'unlimited' as const },
    },
  };
  const stack = new AgentCoreStack(app, 'TokenLimitsTest', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
    envConfig,
    webAclArn: 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/x/y',
  });
  return { template: Template.fromStack(stack), stack };
}

const { template, stack } = synth();

/** Logical ids of IAM policies whose statements mention `needle`. */
const policiesMentioning = (needle: string): string[] =>
  Object.entries(template.findResources('AWS::IAM::Policy'))
    .filter(([, r]) => JSON.stringify(r.Properties.PolicyDocument).includes(needle))
    .map(([id]) => id);

describe('AgentCoreStack with tokenLimits', () => {
  const usageTableId = Object.keys(template.findResources('AWS::DynamoDB::Table')).find((id) =>
    id.startsWith('UsageTable')
  )!;

  it('creates the usage table with TTL and PITR', () => {
    expect(usageTableId).toBeDefined();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'userId', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  it('lets only the Backend role reach the usage table, with Query/UpdateItem only', () => {
    const holders = policiesMentioning(usageTableId);
    expect(holders).toEqual([expect.stringMatching(/^TokenLimitsBackendPolicy/)]);
    const policy = template.findResources('AWS::IAM::Policy')[holders[0]];
    expect(JSON.stringify(policy.Properties.Roles)).toContain('BackendApi');
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'UsageTableReadAdd',
            Action: ['dynamodb:Query', 'dynamodb:UpdateItem'],
          }),
        ]),
      },
    });
  });

  // Regression: the grants used to go into the Backend's DefaultPolicy, which
  // overflowed into an OverflowPolicy without cdk-nag suppressions.
  it('does not overflow the Backend role default policy', () => {
    const overflow = Object.keys(template.findResources('AWS::IAM::Policy')).filter((id) =>
      id.includes('Overflow')
    );
    expect(overflow).toEqual([]);
  });

  it('grants the Cognito group lookup to the Backend only, scoped to the user pool', () => {
    const holders = policiesMentioning('cognito-idp:AdminListGroupsForUser');
    expect(holders).toEqual([expect.stringMatching(/^TokenLimitsBackendPolicy/)]);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'TokenLimitGroupLookup',
            Action: ['cognito-idp:ListUsers', 'cognito-idp:AdminListGroupsForUser'],
            Resource: Match.objectLike({ 'Fn::GetAtt': Match.arrayWith(['Arn']) }),
          }),
        ]),
      },
    });
  });

  it('passes the config to the Backend and flags the Runtime', () => {
    const fns = JSON.stringify(template.toJSON());
    expect(fns).toContain('TOKEN_LIMITS_CONFIG');
    expect(fns).toContain('USAGE_TABLE_NAME');
    const runtime = Object.values(template.findResources('AWS::BedrockAgentCore::Runtime'))[0];
    expect(runtime.Properties.EnvironmentVariables.TOKEN_LIMITS_ENABLED).toBe('true');
    expect(JSON.stringify(runtime.Properties.EnvironmentVariables)).not.toContain(
      'TOKEN_LIMITS_CONFIG'
    );
  });

  it('creates one Cognito group per configured name, including non-ASCII names', () => {
    const names = Object.values(template.findResources('AWS::Cognito::UserPoolGroup')).map(
      (r) => r.Properties.GroupName
    );
    expect(names.sort()).toEqual(['limit-test', '営業'].sort());
  });

  it('passes cdk-nag (no unsuppressed AwsSolutions errors)', () => {
    const errors = Annotations.fromStack(stack)
      .findError('*', Match.stringLikeRegexp('AwsSolutions-.*'))
      // Pre-existing and unrelated: the BucketDeployment singleton is reported
      // in this harness with or without tokenLimits.
      .filter((e) => !e.id.includes('Custom::CDKBucketDeployment'));
    expect(errors.map((e) => `${e.id}: ${e.entry.data}`)).toEqual([]);
  });
});
