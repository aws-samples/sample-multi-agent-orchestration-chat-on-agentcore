import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { CdkCustomResourceIsCompleteEvent } from 'aws-lambda';

const send =
  jest.fn<(cmd: { constructor: { name: string }; input: unknown }) => Promise<unknown>>();
jest.mock('@aws-sdk/client-bedrock-agentcore-control', () => {
  const actual = jest.requireActual<typeof import('@aws-sdk/client-bedrock-agentcore-control')>(
    '@aws-sdk/client-bedrock-agentcore-control'
  );
  return {
    ...actual,
    BedrockAgentCoreControlClient: jest.fn().mockImplementation(() => ({ send })),
  };
});

import { buildUpdateInput, isComplete, onEvent } from './index';

const RUNTIME = {
  $metadata: {},
  agentRuntimeArn: 'arn:aws:bedrock-agentcore:ap-northeast-1:123456789012:runtime/rt-abc',
  agentRuntimeId: 'rt-abc',
  agentRuntimeVersion: '7',
  status: 'READY',
  roleArn: 'arn:aws:iam::123456789012:role/exec',
  agentRuntimeArtifact: { containerConfiguration: { containerUri: 'uri' } },
  networkConfiguration: { networkMode: 'PUBLIC' },
  authorizerConfiguration: { customJWTAuthorizer: { discoveryUrl: 'https://x' } },
  requestHeaderConfiguration: { requestHeaderAllowlist: ['Authorization'] },
  environmentVariables: { A: '1' },
  platformVersion: 'V2',
};

const event = (
  RequestType: 'Create' | 'Update' | 'Delete',
  MinimumMemoryInMiB = '8192'
): CdkCustomResourceIsCompleteEvent =>
  ({
    RequestType,
    ResourceProperties: {
      ServiceToken: 't',
      RuntimeId: 'rt-abc',
      MinimumMemoryInMiB,
      RuntimeVersion: '7',
    },
  }) as unknown as CdkCustomResourceIsCompleteEvent;

const sentUpdates = () =>
  send.mock.calls.map(([c]) => c).filter((c) => c.constructor.name === 'UpdateAgentRuntimeCommand');

describe('runtime-resource-config handler', () => {
  beforeEach(() => {
    send.mockReset();
  });

  it('onEvent only acknowledges with the runtime id as physical id', async () => {
    await expect(onEvent(event('Create') as never)).resolves.toEqual({
      PhysicalResourceId: 'rt-abc',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('echoes the full current configuration and sets the size', () => {
    const input = buildUpdateInput(RUNTIME as never, 'rt-abc', 8192);
    expect(input).toMatchObject({
      agentRuntimeId: 'rt-abc',
      roleArn: RUNTIME.roleArn,
      authorizerConfiguration: RUNTIME.authorizerConfiguration,
      requestHeaderConfiguration: RUNTIME.requestHeaderConfiguration,
      environmentVariables: RUNTIME.environmentVariables,
      platformVersion: 'V2',
      resourceConfigurations: [{ minimumMemoryInMiB: 8192 }],
    });
    expect(input).not.toHaveProperty('$metadata');
  });

  it('omits resourceConfigurations to return to consumption-based sizing', () => {
    const input = buildUpdateInput(
      { ...RUNTIME, resourceConfigurations: [{ minimumMemoryInMiB: 8192 }] } as never,
      'rt-abc',
      undefined
    );
    expect(input).not.toHaveProperty('resourceConfigurations');
  });

  it('waits while the runtime is still updating', async () => {
    send.mockResolvedValueOnce({ ...RUNTIME, status: 'UPDATING' });
    await expect(isComplete(event('Create'))).resolves.toEqual({ IsComplete: false });
    expect(sentUpdates()).toHaveLength(0);
  });

  it('issues an update when READY but the size differs', async () => {
    send.mockResolvedValueOnce(RUNTIME).mockResolvedValueOnce({});
    await expect(isComplete(event('Update'))).resolves.toEqual({ IsComplete: false });
    expect(sentUpdates()).toHaveLength(1);
  });

  it('completes once the size matches', async () => {
    send.mockResolvedValueOnce({
      ...RUNTIME,
      resourceConfigurations: [{ minimumMemoryInMiB: 8192 }],
    });
    await expect(isComplete(event('Update'))).resolves.toEqual({ IsComplete: true });
    expect(sentUpdates()).toHaveLength(0);
  });

  it('fails fast on a FAILED runtime', async () => {
    send.mockResolvedValueOnce({ ...RUNTIME, status: 'UPDATE_FAILED', failureReason: 'boom' });
    await expect(isComplete(event('Update'))).rejects.toThrow(/UPDATE_FAILED: boom/);
  });

  it('resets to consumption-based when the size is removed (Update with empty size)', async () => {
    send
      .mockResolvedValueOnce({ ...RUNTIME, resourceConfigurations: [{ minimumMemoryInMiB: 8192 }] })
      .mockResolvedValueOnce({});
    await expect(isComplete(event('Update', ''))).resolves.toEqual({ IsComplete: false });
    expect(sentUpdates()[0].input).not.toHaveProperty('resourceConfigurations');
  });

  it('completes an empty size on a consumption-based runtime without updating', async () => {
    send.mockResolvedValueOnce(RUNTIME);
    await expect(isComplete(event('Create', ''))).resolves.toEqual({ IsComplete: true });
    expect(sentUpdates()).toHaveLength(0);
  });

  it('never calls the API on Delete, even for a FAILED or missing runtime', async () => {
    send.mockRejectedValue(new Error('should not be called'));
    await expect(isComplete(event('Delete'))).resolves.toEqual({ IsComplete: true });
    expect(send).not.toHaveBeenCalled();
  });
});
