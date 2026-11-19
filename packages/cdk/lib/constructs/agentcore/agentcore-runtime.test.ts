import { describe, expect, it, jest } from '@jest/globals';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { AgentCoreRuntime, AgentCoreRuntimeProps } from './agentcore-runtime';

// Stub the CodeBuild image build: hashing the whole repo is irrelevant here.
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
  return { ContainerImageBuild };
});

const buildStack = (overrides: Partial<AgentCoreRuntimeProps> = {}): cdk.Stack => {
  // Skip esbuild bundling of the Custom Resource handlers.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new cdk.Stack(app, 'Test', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
  });
  new AgentCoreRuntime(stack, 'Runtime', {
    runtimeName: 'mocatest',
    region: 'ap-northeast-1',
    authType: 'iam',
    bedrockModels: [{ id: 'global.anthropic.claude-opus-5', name: 'Opus', provider: 'Anthropic' }],
    ...overrides,
  });
  return stack;
};

const synth = (overrides: Partial<AgentCoreRuntimeProps> = {}): Template =>
  Template.fromStack(buildStack(overrides));

const runtimeProps = (template: Template): Record<string, unknown> =>
  Object.values(template.findResources('AWS::BedrockAgentCore::Runtime'))[0].Properties;

describe('AgentCoreRuntime platform version and sizing', () => {
  it('renders V1 explicitly and no resource configuration by default', () => {
    const props = runtimeProps(synth());
    expect(props.PlatformVersion).toBe('V1');
    expect(props.ResourceConfigurations).toBeUndefined();
    expect((props.EnvironmentVariables as Record<string, string>).RUNTIME_PLATFORM_VERSION).toBe(
      'V1'
    );
  });

  // CFN rejects ResourceConfigurations today, so the size goes through the
  // RuntimeResourceConfig Custom Resource (RUNTIME_MINIMUM_MEMORY_CFN_SUPPORTED = false).
  it('applies a committed baseline via the Custom Resource, not the Runtime resource', () => {
    const template = synth({ platformVersion: 'V2', minimumMemoryMiB: 8192 });
    const props = runtimeProps(template);
    expect(props.PlatformVersion).toBe('V2');
    expect(props.ResourceConfigurations).toBeUndefined();
    expect((props.EnvironmentVariables as Record<string, string>).RUNTIME_PLATFORM_VERSION).toBe(
      'V2'
    );

    const runtimeLogicalId = Object.keys(
      template.findResources('AWS::BedrockAgentCore::Runtime')
    )[0];
    template.hasResourceProperties('Custom::AgentCoreRuntimeResourceConfig', {
      RuntimeId: { 'Fn::GetAtt': [runtimeLogicalId, 'AgentRuntimeId'] },
      MinimumMemoryInMiB: '8192',
      RuntimeVersion: { 'Fn::GetAtt': [runtimeLogicalId, 'AgentRuntimeVersion'] },
      DeployNonce: Match.stringLikeRegexp('^\\d+$'),
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['bedrock-agentcore:GetAgentRuntime', 'bedrock-agentcore:UpdateAgentRuntime'],
            Resource: { 'Fn::GetAtt': [runtimeLogicalId, 'AgentRuntimeArn'] },
          }),
          Match.objectLike({
            Action: 'iam:PassRole',
            Condition: {
              StringEquals: { 'iam:PassedToService': 'bedrock-agentcore.amazonaws.com' },
            },
          }),
        ]),
      },
    });
  });

  // Removing a size must be an Update (reset), never a Delete (no-op).
  it('keeps the Custom Resource with an empty size on V2 without a memory size', () => {
    const template = synth({ platformVersion: 'V2' });
    template.hasResourceProperties('Custom::AgentCoreRuntimeResourceConfig', {
      MinimumMemoryInMiB: '',
    });
  });

  it('creates no Custom Resource on V1', () => {
    const template = synth({ platformVersion: 'V1' });
    template.resourceCountIs('Custom::AgentCoreRuntimeResourceConfig', 0);
  });

  it('renders V2 without resource configuration for consumption-based pricing', () => {
    const props = runtimeProps(synth({ platformVersion: 'V2' }));
    expect(props.PlatformVersion).toBe('V2');
    expect(props.ResourceConfigurations).toBeUndefined();
  });
});

describe('RuntimeResourceConfig cdk-nag', () => {
  // CI synth only covers the default (V1) config, so nag the V2 Custom Resource here.
  it('raises no AwsSolutions errors under the Custom Resource', () => {
    const stack = buildStack({ platformVersion: 'V2', minimumMemoryMiB: 8192 });
    // Mirror the stack-wide suppressions AgentCoreStack applies (agentcore-stack.ts,
    // "cdk-nag Suppressions"); anything else must be handled by the construct itself.
    NagSuppressions.addStackSuppressions(stack, [
      { id: 'AwsSolutions-IAM4', reason: 'mirrors AgentCoreStack' },
      { id: 'AwsSolutions-L1', reason: 'mirrors AgentCoreStack' },
      { id: 'AwsSolutions-IAM5', reason: 'mirrors AgentCoreStack', appliesTo: ['Resource::*'] },
    ]);
    cdk.Aspects.of(stack).add(new AwsSolutionsChecks());
    const errors = Annotations.fromStack(stack)
      .findError('*', Match.stringLikeRegexp('AwsSolutions-'))
      .filter((e) => e.id.includes('/ResourceConfig/'))
      .map((e) => `${e.id}: ${String(e.entry.data).split(':')[0]}`);
    expect(errors).toEqual([]);
  });
});
