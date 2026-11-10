import { describe, expect, it, jest } from '@jest/globals';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentCoreStack } from './agentcore-stack';
import { getEnvironmentConfig } from '../config';

jest.mock('../config/environments', () => ({
  BASE_PREFIX: 'moca',
  environments: { default: { cognitoDomainPrefix: 'moca-test', logRetentionDays: 30 } },
}));

describe('GitHub token broker log group', () => {
  it('uses the retention configured for the environment', () => {
    // Skip esbuild bundling: this test only inspects log group properties.
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = new AgentCoreStack(app, 'Core', {
      env: { account: '123456789012', region: 'ap-northeast-1' },
      envConfig: getEnvironmentConfig('default'),
    });

    const retentions = Object.entries(
      Template.fromStack(stack).findResources('AWS::Logs::LogGroup')
    )
      .filter(([logicalId]) => logicalId.startsWith('GitHubTokenBroker'))
      .map(([, resource]) => resource.Properties.RetentionInDays);

    expect(retentions).toEqual([30]);
  });
});
