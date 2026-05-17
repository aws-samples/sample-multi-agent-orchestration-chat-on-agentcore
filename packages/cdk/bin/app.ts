#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AgentCoreStack } from '../lib/agentcore-stack';
import { AgentCoreGatewayTargetStack } from '../lib/agentcore-gateway-target-stack';
import { WafStack } from '../lib/waf-stack';
import { getEnvironmentConfig, Environment } from '../config';

const app = new cdk.App();
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// Get environment from Context (default: default)
const envContext = app.node.tryGetContext('env') as Environment | undefined;
const envName: Environment = envContext || 'default';

// Get environment configuration
const envConfig = getEnvironmentConfig(envName);

// Stack name: MocaAgentCoreApp (default), MocaAgentCoreAppDev, MocaAgentCoreAppStg, MocaAgentCoreAppPrd, MocaAgentCoreAppPr123
let stackName: string;
if (!envContext) {
  stackName = 'MocaAgentCoreApp';
} else if (envName.startsWith('pr-')) {
  // PR environment: MocaAgentCoreAppPr123
  const prNumber = envName.replace('pr-', '');
  stackName = `MocaAgentCoreAppPr${prNumber}`;
} else {
  // Standard environment: capitalize first letter
  stackName = `MocaAgentCoreApp${envName.charAt(0).toUpperCase() + envName.slice(1)}`;
}

// WAF Stack: creates CloudFront WAF WebACL in us-east-1 (required for CloudFront scope).
// The WebACL ARN is passed cross-region to AgentCoreStack via crossRegionReferences.
//
// Each deploy-region gets its own WAF stack in us-east-1 to avoid resource conflicts when
// deploying to multiple regions from the same account:
//   - ap-northeast-1 → MocaAgentCoreAppApNortheast1Waf / moca-ap-northeast-1-cloudfront-waf
//   - us-west-2      → MocaAgentCoreAppUsWest2Waf      / moca-us-west-2-cloudfront-waf
const deployRegion = process.env.CDK_DEFAULT_REGION ?? 'us-east-1';

// Convert region to PascalCase for use in stack name: ap-northeast-1 → ApNortheast1
const regionPascal = deployRegion
  .split('-')
  .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
  .join('');

// WAF resource prefix includes the deploy region to ensure uniqueness across regions
const wafResourcePrefix = `${envConfig.resourcePrefix}-${deployRegion}`;

// WAF stack name includes the region so each deploy-region has its own independent stack
const wafStackName = `${stackName}${regionPascal}Waf`;

const wafStack = new WafStack(app, wafStackName, {
  env: {
    account: envConfig.awsAccount || process.env.CDK_DEFAULT_ACCOUNT,
    // WAF for CloudFront must always be in us-east-1
    region: 'us-east-1',
  },
  resourcePrefix: wafResourcePrefix,
  description: `Amazon Bedrock AgentCore WAF (CloudFront) - ${envName.toUpperCase()} environment`,
  terminationProtection: envConfig.deletionProtection,
});

// Core Stack: manages foundational resources (Gateway, Cognito, Memory, Storage, Runtime, Frontend).
// Gateway targets are separated into AgentCoreGatewayTargetStack to split the deployment unit,
// allowing each target to be deployed independently without affecting core infrastructure.
const coreStack = new AgentCoreStack(app, stackName, {
  env: {
    account: envConfig.awsAccount || process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  // Enable cross-region references so that WafStack (us-east-1) ARN can be referenced
  // by AgentCoreStack (e.g., ap-northeast-1) without manual SSM/export wiring.
  crossRegionReferences: true,
  envConfig: envConfig,
  tavilyApiKeySecretName: envConfig.tavilyApiKeySecretName,
  description: `Amazon Bedrock AgentCore - ${envName.toUpperCase()} environment`,
  terminationProtection: envConfig.deletionProtection,
  webAclArn: wafStack.webAclArn,
});
coreStack.addDependency(wafStack);

// Gateway Target Stack: manages Gateway targets (Lambda Tools) as a separate deployment unit.
// By splitting targets into their own stack, additions, changes, and removals of targets
// can be deployed independently without impacting core resources.
// Uses Fn::ImportValue (via coreStackName) for cross-stack Gateway reference,
// or accepts direct Gateway attributes (gatewayArn, etc.) for connecting to externally managed Gateways.
const targetStackName = `${stackName}Targets`;
const targetStack = new AgentCoreGatewayTargetStack(app, targetStackName, {
  env: {
    account: envConfig.awsAccount || process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  envConfig: envConfig,
  coreStackName: stackName,
  description: `Amazon Bedrock AgentCore Gateway Targets - ${envName.toUpperCase()} environment`,
  terminationProtection: envConfig.deletionProtection,
});
targetStack.addDependency(coreStack);

// Output environment information
console.log(`🚀 Deploying AgentCore Stack for environment: ${envName}`);
console.log(`📦 Core Stack Name: ${stackName}`);
console.log(`📦 Target Stack Name: ${targetStackName}`);
console.log(`🌍 Region: ${process.env.CDK_DEFAULT_REGION || 'not set (will use AWS_REGION)'}`);
console.log(`🔒 Deletion Protection: ${envConfig.deletionProtection ? 'ENABLED' : 'DISABLED'}`);
