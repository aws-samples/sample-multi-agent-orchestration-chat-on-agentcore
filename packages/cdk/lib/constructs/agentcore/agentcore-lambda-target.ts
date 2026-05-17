import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Tool Schema file type definition
 * Using unknown to maintain compatibility with AgentCore types
 */
interface ToolSchemaFile {
  tools: unknown[];
}

/**
 * Get project root directory from CDK package
 * CDK is always run from packages/cdk/, so go 2 levels up to reach repo root.
 */
const PROJECT_ROOT = path.resolve(process.cwd(), '../..');

export interface AgentCoreLambdaTargetProps {
  /**
   * Resource name prefix (optional)
   * Lambda function name: {resourcePrefix}-{targetName}-function
   * @default 'agentcore'
   */
  readonly resourcePrefix?: string;

  /**
   * Target name
   */
  readonly targetName: string;

  /**
   * Target description (optional)
   */
  readonly description?: string;

  /**
   * Lambda function source code directory
   * Relative path (from project root)
   */
  readonly lambdaCodePath: string;

  /**
   * Tool Schema file path
   * Relative path (from project root)
   */
  readonly toolSchemaPath: string;

  /**
   * Lambda runtime (optional)
   * @default Runtime.NODEJS_22_X
   */
  readonly runtime?: lambda.Runtime;

  /**
   * Lambda timeout duration (optional)
   * @default 30 seconds
   */
  readonly timeout?: number;

  /**
   * Lambda memory size (optional)
   * @default 256MB
   */
  readonly memorySize?: number;

  /**
   * Environment variables (optional)
   */
  readonly environment?: { [key: string]: string };

  /**
   * Request headers to forward from the incoming request to this target (optional).
   * Headers listed here are passed to the interceptor Lambda and forwarded to the target.
   * Maximum 10 headers. Header names must be alphanumeric, hyphens, or underscores.
   * Note: Headers starting with X-Amzn- are prohibited except for
   *       X-Amzn-Bedrock-AgentCore-Runtime-Custom-* headers.
   */
  readonly allowedRequestHeaders?: string[];
}

/**
 * AgentCore Gateway Lambda Target Construct
 *
 * Construct for adding Lambda functions as targets to AgentCore Gateway
 */
export class AgentCoreLambdaTarget extends Construct {
  /**
   * Created Lambda function
   */
  public readonly lambdaFunction: nodejs.NodejsFunction;

  /**
   * Tool Schema
   */
  public readonly toolSchema: agentcore.ToolSchema;

  /**
   * Target name
   */
  public readonly targetName: string;

  private readonly allowedRequestHeaders: string[] | undefined;

  constructor(scope: Construct, id: string, props: AgentCoreLambdaTargetProps) {
    super(scope, id);

    this.targetName = props.targetName;
    this.allowedRequestHeaders = props.allowedRequestHeaders;

    // Load Tool Schema
    const toolSchemaContent = this.loadToolSchema(props.toolSchemaPath);
    // Cast to any to maintain compatibility with AgentCore types
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.toolSchema = agentcore.ToolSchema.fromInline(toolSchemaContent.tools as any);

    // Get resource prefix
    const resourcePrefix = props.resourcePrefix || 'agentcore';

    // Explicit log group so stack deletion cleans it up and redeploys don't
    // collide with a previously auto-created group of the same name.
    const logGroup = new logs.LogGroup(this, 'FunctionLogGroup', {
      logGroupName: `/aws/lambda/${resourcePrefix}-${props.targetName}-function`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create Lambda function
    this.lambdaFunction = new nodejs.NodejsFunction(this, 'Function', {
      functionName: `${resourcePrefix}-${props.targetName}-function`,
      runtime: props.runtime || lambda.Runtime.NODEJS_22_X,
      // ARM64 (Graviton2) — pure Node.js + AWS SDK tool workloads, no native
      // bindings. Consumers overriding runtime should keep arm64 unless they
      // introduce x86_64-only dependencies.
      architecture: lambda.Architecture.ARM_64,
      // nosemgrep: path-join-resolve-traversal - lambdaCodePath is a CDK build-time configuration, not user input
      entry: path.join(PROJECT_ROOT, props.lambdaCodePath, 'src', 'handler.ts'),
      handler: 'handler',
      timeout: props.timeout ? cdk.Duration.seconds(props.timeout) : cdk.Duration.seconds(30),
      memorySize: props.memorySize || 256,
      description: props.description || `AgentCore Gateway Target: ${props.targetName}`,
      logGroup,
      environment: {
        NODE_ENV: 'production',
        ...props.environment,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'es2022',
        // `aws-sdk` (v2) removed: Node 22 Lambda runtime does not ship it
        // anymore. We keep `@aws-sdk/client-bedrock-agent-runtime` external
        // because the Node 22 runtime provides AWS SDK v3 and bundling this
        // client would only add cold-start-critical bytes for no benefit.
        externalModules: ['@aws-sdk/client-bedrock-agent-runtime'],
      },
    });

    // Lambda log output settings
    this.lambdaFunction.addEnvironment('AWS_LAMBDA_LOG_LEVEL', 'INFO');
  }

  /**
   * Load Tool Schema file
   */
  private loadToolSchema(schemaPath: string): ToolSchemaFile {
    try {
      // nosemgrep: path-join-resolve-traversal - schemaPath is a CDK build-time configuration, not user input
      const fullPath = path.join(PROJECT_ROOT, schemaPath);
      const schemaContent = fs.readFileSync(fullPath, 'utf8');
      const schema = JSON.parse(schemaContent) as ToolSchemaFile;

      // Validate Tool Schema structure
      if (!schema.tools || !Array.isArray(schema.tools)) {
        throw new Error("Tool schema must have a 'tools' array");
      }

      return schema;
    } catch (error) {
      throw new Error(`Failed to load tool schema from ${schemaPath}: ${error}`, { cause: error });
    }
  }

  /**
   * Add this Lambda Target to Gateway (L2 Construct - same stack)
   */
  public addToGateway(gateway: agentcore.Gateway, targetId: string): agentcore.GatewayTarget {
    const target = gateway.addLambdaTarget(targetId, {
      gatewayTargetName: this.targetName,
      lambdaFunction: this.lambdaFunction,
      toolSchema: this.toolSchema,
      description: `Lambda target for ${this.targetName}`,
    });

    // CDK L2 calls grantInvoke but dependency is not set,
    // so explicitly set GatewayTarget to depend on Gateway role
    target.node.addDependency(gateway.role);

    return target;
  }

  /**
   * Add this Lambda Target to an imported Gateway (cross-stack)
   *
   * Uses GatewayTarget.forLambda() with an IGateway obtained from
   * Gateway.fromGatewayAttributes(), enabling cross-stack deployment.
   *
   * @param importedGateway - IGateway instance from Gateway.fromGatewayAttributes()
   * @param targetId - CloudFormation logical ID for the target resource
   */
  public addToImportedGateway(
    importedGateway: agentcore.IGateway,
    targetId: string
  ): agentcore.GatewayTarget {
    return agentcore.GatewayTarget.forLambda(this, targetId, {
      gateway: importedGateway,
      gatewayTargetName: this.targetName,
      lambdaFunction: this.lambdaFunction,
      toolSchema: this.toolSchema,
      description: `Lambda target for ${this.targetName}`,
      ...(this.allowedRequestHeaders &&
        this.allowedRequestHeaders.length > 0 && {
          metadataConfiguration: {
            allowedRequestHeaders: this.allowedRequestHeaders,
          },
        }),
    });
  }
}
