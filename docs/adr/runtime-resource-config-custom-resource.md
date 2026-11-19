# Applying AgentCore Runtime session size through a Custom Resource (temporary)

## Status

Temporary. Retire it once CloudFormation accepts `ResourceConfigurations` in every region you deploy to (see "Retirement").

## Context

On AgentCore Runtime V2, `resourceConfigurations[].minimumMemoryInMiB` (1024 / 2048 / 4096 / 8192) sets a committed per-session baseline. Administrators set it with `runtimeMinimumMemoryMiB` in `environments.ts`.

The layers do not support it equally. Status as of 2026-11-18:

| Layer | `ResourceConfigurations` |
|---|---|
| AgentCore control plane (`UpdateAgentRuntime`) | Supported |
| AWS SDK JS ≥ 3.1171 | Supported |
| aws-cdk-lib 2.277 (L1, L2 `minimumMemory`) | Supported; rendered into the template |
| CloudFormation `AWS::BedrockAgentCore::Runtime` schema | **Rolling out per region.** Present in us-east-2 and ap-southeast-2. Missing in ap-northeast-1, us-east-1, us-west-2 and most other regions, where stack updates fail with `extraneous key [ResourceConfigurations] is not permitted`. |

Passing the size to the L2 therefore breaks deployments in most regions.

## Decision

The `RuntimeResourceConfig` Custom Resource (`packages/cdk/lib/constructs/agentcore/runtime-resource-config.ts`, handler in `packages/cdk/lambda/runtime-resource-config/`) applies the size through the control-plane API after CloudFormation has updated the Runtime.

- **Echo the full config.** `UpdateAgentRuntime` replaces the whole configuration, so the handler sends back the `GetAgentRuntime` response and swaps only `resourceConfigurations`.
- **Re-apply after every CFN Runtime update.** CloudFormation's Runtime update omits `resourceConfigurations`, and the API treats an omission as "reset to consumption-based". This was observed in dev: v98 had 8192, CFN's update produced v99 with no size, and the Custom Resource produced v100 with 8192 again. The resource therefore carries the Runtime's `AgentRuntimeVersion`.
- **Re-converge on every deploy.** The resource also carries a `DeployNonce` that changes on every synth. `RuntimeVersion` alone misses a rolled-back Runtime update: the rollback clears the size but does not re-run this resource, and the next deploy may not touch the Runtime. When the size already matches, the handler only issues one `GetAgentRuntime`.
- **Converge in `isComplete`.** The Provider framework's `isComplete` handler does all the work. It waits while the Runtime is UPDATING, updates only when the Runtime is READY and the size differs, and completes when the size matches. It never hits `ConflictException` from CloudFormation's own update or from the V2 snapshot build.
- **Exists for every V2 Runtime**, sized or not. Removing a size is an **Update** to `MinimumMemoryInMiB: ''`, which resets the Runtime to consumption-based.
- **Delete is a no-op.** A Delete only happens on stack teardown, Runtime replacement, or retirement of this workaround.
  - On retirement, CloudFormation has already updated the Runtime with the size before the cleanup phase deletes this resource. A reset here would undo that.
  - Updating a Runtime that is about to be deleted only costs a snapshot rebuild.
  - A throw would leave the stack in `DELETE_FAILED`.
- **Minimal IAM.** The handler gets `GetAgentRuntime` / `UpdateAgentRuntime` on this Runtime's ARN, plus `iam:PassRole` on its execution role with `PassedToService=bedrock-agentcore`. This is enough for PUBLIC network mode, verified in dev. VPC mode may additionally need what the CFN handler uses, such as `ec2:*NetworkInterface`.

### Known side effects

- When a size is set, deploys that change the Runtime build the V2 snapshot twice (CFN, then the Custom Resource). This adds Runtime versions and deploy time.
- Sessions that start between the two updates run consumption-based (2 vCPU / 8 GB).
- The Runtime's actual version is one ahead of what CloudFormation recorded, which drift detection reports.
- Every deploy shows a diff for the Custom Resource because of `DeployNonce`.
- If the Custom Resource's own update leaves the Runtime in `UPDATE_FAILED`, the rollback update sees the same failed Runtime and throws too. The stack then ends in `UPDATE_ROLLBACK_FAILED` and needs `continue-update-rollback`. A rollback update cannot be told apart from a normal update, so this is accepted.

## Rejected alternatives

- **Wait for CloudFormation.** No code, but the size cannot be set until then.
- **Call `UpdateAgentRuntime` from `AwsCustomResource`.** A single SDK call cannot read the current config before updating. The template would have to rebuild every field, duplicating the CloudFormation-managed config.
- **Manage the whole Runtime with a Custom Resource.** Far wider blast radius, and a heavy migration back to the L2 later.
- **Per-region switch.** Use CFN where the schema already supports the property and the Custom Resource elsewhere. The Custom Resource also works where CFN supports the property, because CFN does not send a size the template omits. A single global switch keeps one code path until every deploy region is covered.

## Retirement

Check **every region you deploy to**; the schema rolls out per region:

```bash
for r in ap-northeast-1 us-east-1; do  # list all deploy regions
  printf '%s ' "$r"
  aws cloudformation describe-type --region "$r" --type RESOURCE \
    --type-name AWS::BedrockAgentCore::Runtime --query Schema --output text \
    | jq '.properties | has("ResourceConfigurations")'
done
```

Once every region prints `true`, do the following in one release:

1. Set `RUNTIME_MINIMUM_MEMORY_CFN_SUPPORTED` in `packages/cdk/config/environment-utils.ts` to `true`, so CloudFormation applies the size through the L2 `minimumMemory`.
2. Delete the `RuntimeResourceConfig` construct, `packages/cdk/lambda/runtime-resource-config/`, the branch in `agentcore-runtime.ts`, the `@aws-sdk/client-bedrock-agentcore-control` devDependency (unless something else uses it), and the flag.
3. Delete this ADR.

Steps 1 and 2 can ship together. CloudFormation updates the Runtime with the size, then deletes the Custom Resource in the cleanup phase. Its Delete is a no-op, so the size stays.
