import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface AgentCoreMemoryProps {
  /**
   * Memory name
   * Only letters, numbers, and underscores are allowed
   */
  readonly memoryName: string;

  /**
   * Memory description (optional)
   */
  readonly description?: string;

  /**
   * Short-term memory expiration period (days)
   * Specify between 7 and 365 days
   * @default 90 days
   */
  readonly expirationDuration?: cdk.Duration;

  /**
   * Long-term memory extraction strategies
   * @default none (short-term memory only)
   */
  readonly memoryStrategies?: agentcore.IMemoryStrategy[];

  /**
   * KMS key for encryption (optional)
   * If not specified, AWS managed key is used
   */
  readonly kmsKey?: kms.IKey;

  /**
   * IAM role for Memory execution (optional)
   * If not specified, a role with CloudWatch Logs permissions is auto-generated
   */
  readonly executionRole?: iam.IRole;

  /**
   * Tags (optional)
   */
  readonly tags?: { [key: string]: string };

  /**
   * Whether to use built-in strategies when creating Memory
   * If true, automatically adds Semantic strategy
   * Extracts general facts, concepts, and meanings from conversations using vector embeddings for similarity search
   * @default false
   */
  readonly useBuiltInStrategies?: boolean;

  /**
   * Whether to auto-create executionRole
   * If true, auto-generates an IAM role with CloudWatch Logs permissions
   * @default true
   */
  readonly createExecutionRole?: boolean;
}

/**
 * Amazon Bedrock AgentCore Memory Construct
 *
 * Provides persistence of conversation history and context management.
 * Supports both short-term and long-term memory, allowing AI agents to
 * remember past conversations and provide consistent responses.
 */
export class AgentCoreMemory extends Construct {
  /**
   * Created Memory instance
   */
  public readonly memory: agentcore.Memory;

  /**
   * Memory ID
   */
  public readonly memoryId: string;

  /**
   * Memory ARN
   */
  public readonly memoryArn: string;

  /**
   * Memory name
   */
  public readonly memoryName: string;

  /**
   * The strategyId of the built-in semantic memory strategy, resolved at
   * deploy time via `GetMemory`.
   *
   * AWS generates a unique suffix per strategy (e.g.
   * `semantic_memory_strategy-Zm6Brc4FaH`) which is required by
   * `RetrieveMemoryRecords` / `ListMemoryRecords` to compose the namespace
   * `/strategies/{strategyId}/actors/{actorId}`. The suffix is not known
   * until after the Memory resource is fully created, so we resolve it with
   * an `AwsCustomResource` that calls `GetMemory` on deploy and caches the
   * value for the runtime. Consumers receive it as a CFN token.
   *
   * Only populated when `useBuiltInStrategies` is true — otherwise the
   * caller is responsible for managing its own strategy IDs.
   */
  public readonly semanticStrategyId?: string;

  constructor(scope: Construct, id: string, props: AgentCoreMemoryProps) {
    super(scope, id);

    // Set default values
    const expirationDuration = props.expirationDuration || cdk.Duration.days(90);
    const createExecutionRole = props.createExecutionRole ?? true;
    let memoryStrategies = props.memoryStrategies;

    // Use built-in strategies if specified
    if (props.useBuiltInStrategies && !memoryStrategies) {
      memoryStrategies = [
        agentcore.MemoryStrategy.usingSemantic({
          name: 'semantic_memory_strategy',
          namespaces: ['/strategies/{memoryStrategyId}/actors/{actorId}'],
          description:
            'Semantic memory strategy - extracts general facts, concepts, and meanings from conversations',
        }),
      ];
    }

    // Determine executionRole
    let executionRole = props.executionRole;
    if (!executionRole && createExecutionRole) {
      executionRole = this.createExecutionRole(props.memoryName);
    }

    // Create Memory
    this.memory = new agentcore.Memory(this, 'Memory', {
      memoryName: props.memoryName,
      description: props.description,
      expirationDuration: expirationDuration,
      memoryStrategies: memoryStrategies,
      kmsKey: props.kmsKey,
      executionRole: executionRole,
      tags: props.tags,
    });

    // Set properties
    this.memoryId = this.memory.memoryId;
    this.memoryArn = this.memory.memoryArn;
    this.memoryName = props.memoryName;

    // Resolve the semantic strategyId at deploy time (see
    // `buildSemanticStrategyResolver` for the mechanism). Only populated when
    // `useBuiltInStrategies` is true — the only code path where we know a
    // single semantic strategy is present at index 0.
    if (props.useBuiltInStrategies) {
      this.semanticStrategyId = this.buildSemanticStrategyResolver().getResponseField(
        'memory.strategies.0.strategyId'
      );
    }
  }

  /**
   * Build an AwsCustomResource that calls `GetMemory` on this Memory at deploy
   * time and returns the first strategy's id from `memory.strategies[]`.
   * Scoped to this Memory's ARN only.
   *
   * NOTE: AgentCore does not expose a standalone `ListMemoryStrategies` API —
   * strategies are only retrievable as a sub-field of `GetMemory`. The SDK
   * command name is therefore `GetMemoryCommand` and the IAM action is
   * `bedrock-agentcore:GetMemory`.
   */
  private buildSemanticStrategyResolver(): cr.AwsCustomResource {
    const call: cr.AwsSdkCall = {
      service: '@aws-sdk/client-bedrock-agentcore-control',
      action: 'GetMemoryCommand',
      parameters: { memoryId: this.memoryId },
      physicalResourceId: cr.PhysicalResourceId.of(`${this.memoryId}-strategies`),
    };
    const resolver = new cr.AwsCustomResource(this, 'SemanticStrategyResolver', {
      onCreate: call,
      onUpdate: call,
      // No onDelete — strategy resolution is idempotent, nothing to clean up.
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['bedrock-agentcore:GetMemory'],
          resources: [this.memoryArn],
        }),
      ]),
      installLatestAwsSdk: false,
    });
    // Ensure the resolver runs after the Memory resource is CREATE_COMPLETE.
    resolver.node.addDependency(this.memory);
    return resolver;
  }

  /**
   * Grant read permissions to the specified IAM principal for Memory
   */
  public grantRead(grantee: iam.IGrantable): iam.Grant {
    return this.memory.grantRead(grantee);
  }

  /**
   * Grant specific Action permissions to the specified IAM principal
   */
  public grant(grantee: iam.IGrantable, ...actions: string[]): iam.Grant {
    return this.memory.grant(grantee, ...actions);
  }

  /**
   * Get Memory configuration as environment variables
   */

  public getEnvironmentVariables(): { [key: string]: string } {
    return {
      AGENTCORE_MEMORY_ID: this.memoryId,
    };
  }

  /**
   * Create executionRole with CloudWatch Logs permissions
   * @param memoryName Memory name (used as part of role name)
   * @returns Created IAM Role
   */
  private createExecutionRole(memoryName: string): iam.Role {
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: `Execution role for AgentCore Memory: ${memoryName} in ${cdk.Stack.of(this).region}`,
    });

    // Add CloudWatch Logs permissions
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          `arn:aws:logs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:log-group:/aws/bedrock-agentcore/memory/${memoryName}*`,
        ],
      })
    );

    return executionRole;
  }
}
