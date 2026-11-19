/**
 * Applies AgentCore Runtime `resourceConfigurations` (minimumMemoryInMiB) via a
 * Custom Resource because CloudFormation's AWS::BedrockAgentCore::Runtime does
 * not accept `ResourceConfigurations` yet ("extraneous key ... is not permitted"),
 * although aws-cdk-lib already renders it from the L2 `minimumMemory` prop.
 *
 * TEMPORARY — remove this construct, lambda/runtime-resource-config/, and the
 * `@aws-sdk/client-bedrock-agentcore-control` devDependency once the CFN schema
 * supports the property; then flip RUNTIME_MINIMUM_MEMORY_CFN_SUPPORTED so the
 * size is passed to the L2 `Runtime` directly. Do both in one release: the
 * handler's Delete is a no-op, so the size CFN now applies is left in place.
 * See docs/adr/runtime-resource-config-custom-resource.md.
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import * as path from 'path';

export interface RuntimeResourceConfigProps {
  readonly runtime: agentcore.Runtime;
  /** Omit for consumption-based sizing (the resource still exists, so removing a size is an Update). */
  readonly minimumMemoryMiB?: number;
}

export class RuntimeResourceConfig extends Construct {
  constructor(scope: Construct, id: string, props: RuntimeResourceConfigProps) {
    super(scope, id);

    const entry = path.join(__dirname, '../../../lambda/runtime-resource-config/index.ts');
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const fnProps: Omit<nodejs.NodejsFunctionProps, 'handler'> = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry,
      timeout: cdk.Duration.minutes(1),
      memorySize: 256,
      logGroup,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'es2022',
        // Bundle the SDK: the Lambda-provided SDK may predate resourceConfigurations,
        // and schema-based serializers silently drop members they do not know.
        externalModules: [],
      },
    };
    const onEvent = new nodejs.NodejsFunction(this, 'OnEvent', { ...fnProps, handler: 'onEvent' });
    const isComplete = new nodejs.NodejsFunction(this, 'IsComplete', {
      ...fnProps,
      handler: 'isComplete',
    });

    const runtimeArn = props.runtime.agentRuntimeArn;
    isComplete.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:GetAgentRuntime', 'bedrock-agentcore:UpdateAgentRuntime'],
        resources: [runtimeArn],
      })
    );
    // UpdateAgentRuntime re-submits the Runtime's own execution role.
    isComplete.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [props.runtime.role.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'bedrock-agentcore.amazonaws.com' } },
      })
    );

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: onEvent,
      isCompleteHandler: isComplete,
      // V2 updates rebuild the snapshot (several minutes), possibly twice when
      // CloudFormation's own Runtime update is still settling.
      queryInterval: cdk.Duration.seconds(30),
      totalTimeout: cdk.Duration.hours(1),
      // Logging is opt-in for the waiter (the default disables it).
      disableWaiterStateMachineLogging: false,
      waiterStateMachineLogOptions: {
        destination: new logs.LogGroup(this, 'WaiterLogGroup', {
          // Step Functions log delivery keeps its resource policy small under /aws/vendedlogs/.
          logGroupName: `/aws/vendedlogs/states/${cdk.Names.uniqueResourceName(this, { maxLength: 200 })}`,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ALL,
        // Execution data echoes the Runtime config (env vars); keep it out of logs.
        includeExecutionData: false,
      },
    });
    NagSuppressions.addResourceSuppressions(
      provider,
      [
        {
          id: 'AwsSolutions-SF2',
          reason:
            'The Provider framework waiter state machine does not expose X-Ray tracing; it only polls isComplete.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'The Provider framework grants lambda:InvokeFunction on <fn>:* so the waiter can invoke the handler versions/aliases it created.',
          appliesTo: [{ regex: '/^Resource::<.+\\.Arn>:\\*$/' }],
        },
      ],
      true
    );

    const resource = new cdk.CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::AgentCoreRuntimeResourceConfig',
      properties: {
        RuntimeId: props.runtime.agentRuntimeId,
        MinimumMemoryInMiB:
          props.minimumMemoryMiB !== undefined ? String(props.minimumMemoryMiB) : '',
        // Every CFN update of the Runtime omits resourceConfigurations, which the
        // service treats as "reset to consumption-based". The version attribute
        // changes on each such update, so this resource re-applies the size.
        // Typed optional only because imported Runtimes may lack it; always set for an L2 Runtime.
        RuntimeVersion: props.runtime.agentRuntimeVersion ?? '',
        // Changes on every synth so the resource re-converges on every deploy.
        // RuntimeVersion alone misses a rolled-back Runtime update: CFN's
        // rollback clears the size but does not re-run this resource, and the
        // next deploy may not touch the Runtime. A matching size costs one Get.
        DeployNonce: Date.now().toString(),
      },
    });
    resource.node.addDependency(props.runtime);
  }
}
