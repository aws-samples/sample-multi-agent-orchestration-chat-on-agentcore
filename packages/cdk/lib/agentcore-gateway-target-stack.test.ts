import { describe, expect, it, jest } from '@jest/globals';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentCoreGatewayTargetStack } from './agentcore-gateway-target-stack';
import { getEnvironmentConfig, EnvironmentConfigInput } from '../config';

jest.mock('../config/environments', () => ({
  BASE_PREFIX: 'moca',
  environments: { default: { cognitoDomainPrefix: 'moca-test' } },
}));

const synth = (overrides: EnvironmentConfigInput, region = 'ap-northeast-1'): Template => {
  // Skip esbuild bundling: these tests only inspect Gateway target wiring.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new AgentCoreGatewayTargetStack(app, 'Targets', {
    env: { account: '123456789012', region },
    envConfig: { ...getEnvironmentConfig('default'), ...overrides },
    gatewayArn: 'arn:aws:bedrock-agentcore:ap-northeast-1:123456789012:gateway/gw-abc',
    gatewayId: 'gw-abc',
    gatewayName: 'gw',
    gatewayRoleArn: 'arn:aws:iam::123456789012:role/gw-role',
  });
  return Template.fromStack(stack);
};

const targetNames = (template: Template): string[] =>
  Object.values(template.findResources('AWS::BedrockAgentCore::GatewayTarget')).map(
    (r) => r.Properties.Name
  );

describe('web search provider targets', () => {
  it('deploys only the Tavily target by default', () => {
    const names = targetNames(synth({}));
    expect(names).toContain('tavily-tools');
    expect(names).not.toContain('web-search');
  });

  it('deploys only the AgentCore Web Search connector for provider "agentcore"', () => {
    const template = synth({
      webSearchProvider: 'agentcore',
      agentcoreWebSearch: { excludeDomains: ['example.com'] },
    });
    const names = targetNames(template);
    expect(names).toContain('web-search');
    expect(names).not.toContain('tavily-tools');

    template.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      Name: 'web-search',
      TargetConfiguration: {
        Mcp: {
          Connector: {
            Source: { ConnectorId: 'web-search' },
            Configurations: [
              {
                Name: 'WebSearch',
                ParameterValues: { domainFilter: { exclude: ['example.com'] } },
              },
            ],
          },
        },
      },
      CredentialProviderConfigurations: [{ CredentialProviderType: 'GATEWAY_IAM_ROLE' }],
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'bedrock-agentcore:InvokeWebSearch',
            Resource: 'arn:aws:bedrock-agentcore:ap-northeast-1:aws:tool/web-search.v1',
          },
        ],
      },
    });
  });

  it('fails synth for provider "agentcore" in a region without the connector', () => {
    expect(() => synth({ webSearchProvider: 'agentcore' }, 'us-west-2')).toThrow(
      /not available in us-west-2/
    );
  });
});
