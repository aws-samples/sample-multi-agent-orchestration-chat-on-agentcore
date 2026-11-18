/**
 * Custom Resource: apply `resourceConfigurations` (minimumMemoryInMiB) to an
 * AgentCore Runtime through the control-plane API.
 *
 * TEMPORARY WORKAROUND — delete this handler (and the RuntimeResourceConfig
 * construct) once CloudFormation's AWS::BedrockAgentCore::Runtime schema
 * accepts `ResourceConfigurations`; then pass `minimumMemory` to the L2
 * `Runtime` instead. Check with:
 *   aws cloudformation describe-type --type RESOURCE \
 *     --type-name AWS::BedrockAgentCore::Runtime --query Schema --output text \
 *     | jq '.properties | has("ResourceConfigurations")'
 * See docs/adr/runtime-resource-config-custom-resource.md.
 *
 * Provider-framework contract: `onEvent` only acknowledges; `isComplete` is
 * polled and converges the Runtime to the desired size. All API calls live in
 * `isComplete` so a Runtime that is still UPDATING (CloudFormation's own update,
 * or the V2 snapshot build) is simply waited on instead of hitting
 * ConflictException.
 */

import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeCommand,
  GetAgentRuntimeCommandOutput,
  UpdateAgentRuntimeCommand,
  UpdateAgentRuntimeCommandInput,
} from '@aws-sdk/client-bedrock-agentcore-control';
import type {
  CdkCustomResourceEvent,
  CdkCustomResourceIsCompleteEvent,
  CdkCustomResourceIsCompleteResponse,
  CdkCustomResourceResponse,
} from 'aws-lambda';

export interface ResourceConfigProps {
  RuntimeId: string;
  /** Desired baseline in MiB; empty string = consumption-based (no resourceConfigurations). */
  MinimumMemoryInMiB: string;
  /** Changes on every CloudFormation update of the Runtime, re-triggering this resource. */
  RuntimeVersion: string;
}

const client = new BedrockAgentCoreControlClient({});

export async function onEvent(event: CdkCustomResourceEvent): Promise<CdkCustomResourceResponse> {
  const props = event.ResourceProperties as unknown as ResourceConfigProps;
  return { PhysicalResourceId: props.RuntimeId };
}

function desiredMemory(event: CdkCustomResourceIsCompleteEvent): number | undefined {
  const raw = (event.ResourceProperties as unknown as ResourceConfigProps).MinimumMemoryInMiB;
  return raw ? Number(raw) : undefined;
}

function currentMemory(runtime: GetAgentRuntimeCommandOutput): number | undefined {
  return runtime.resourceConfigurations?.[0]?.minimumMemoryInMiB;
}

/**
 * UpdateAgentRuntime replaces the whole configuration, so every field the
 * Runtime currently has is echoed back. The SDK serializes only members of the
 * Update input shape, so read-only Get fields (status, ARN, ...) are dropped and
 * any field added to both shapes later is carried over without code changes.
 */
export function buildUpdateInput(
  runtime: GetAgentRuntimeCommandOutput,
  runtimeId: string,
  memory: number | undefined
): UpdateAgentRuntimeCommandInput {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { $metadata, resourceConfigurations, ...rest } = runtime;
  return {
    ...(rest as unknown as UpdateAgentRuntimeCommandInput),
    agentRuntimeId: runtimeId,
    ...(memory !== undefined ? { resourceConfigurations: [{ minimumMemoryInMiB: memory }] } : {}),
  };
}

export async function isComplete(
  event: CdkCustomResourceIsCompleteEvent
): Promise<CdkCustomResourceIsCompleteResponse> {
  // Delete is a no-op on purpose. "No size" is expressed as an Update with an
  // empty MinimumMemoryInMiB (the resource exists for every V2 Runtime), so a
  // Delete only happens on stack teardown, Runtime replacement, or when this
  // workaround is retired — and in the last case CFN has just applied the size
  // itself, during the cleanup phase that precedes this Delete. Resetting here
  // would undo it; touching a Runtime that is about to be deleted only costs a
  // snapshot rebuild; and a throw here would wedge the stack in DELETE_FAILED.
  if (event.RequestType === 'Delete') return { IsComplete: true };

  const { RuntimeId } = event.ResourceProperties as unknown as ResourceConfigProps;
  const desired = desiredMemory(event);
  const runtime = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId: RuntimeId }));

  const status = runtime.status ?? '';
  const current = currentMemory(runtime);
  console.log(
    JSON.stringify({ RuntimeId, status, current, desired, version: runtime.agentRuntimeVersion })
  );

  if (status.endsWith('FAILED')) {
    // Surface a failed update instead of retrying until the Provider times out.
    // A rollback Update against the same failed Runtime also throws; that
    // needs `continue-update-rollback` (see the ADR's known side effects).
    throw new Error(`Runtime ${RuntimeId} is ${status}: ${runtime.failureReason ?? 'unknown'}`);
  }
  if (status !== 'READY') return { IsComplete: false };
  if (current === desired) return { IsComplete: true };

  await client.send(new UpdateAgentRuntimeCommand(buildUpdateInput(runtime, RuntimeId, desired)));
  return { IsComplete: false };
}
