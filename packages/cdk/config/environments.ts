import * as cdk from 'aws-cdk-lib';
import type { Environment, EnvironmentConfigInput } from './environment-types';

/**
 * Base prefix for resource naming
 * All resources are named in the format: {BASE_PREFIX}{env}
 * Examples: moca, mocadev, mocastg, mocaprd
 */
export const BASE_PREFIX = 'moca';

/**
 * Environment-specific configurations
 *
 * - env: Automatically derived from object key
 * - resourcePrefix: Auto-generated as 'moca' + env if not specified
 * - Others: Default values applied if not specified
 *
 * Default values:
 *   - deletionProtection: false
 *   - corsAllowedOrigins: ['*']
 *   - memoryExpirationDays: 30
 *   - s3RemovalPolicy: DESTROY
 *   - s3AutoDeleteObjects: true
 *   - cognitoDeletionProtection: false
 *     (when false, UserPool/Domain/ResourceServer are destroyed with the stack
 *      via RemovalPolicy.DESTROY — see CognitoAuth construct)
 *   - cognitoDomainPrefix: required per environment — Cognito's domain namespace
 *     is GLOBAL across all AWS accounts, so each environment must pick a unique value.
 *   - logRetentionDays: 7
 *   - tavilyApiKeySecretName: 'agentcore/default/tavily-api-key'
 *   - githubTokenSecretName: 'agentcore/default/github-token'
 *   - githubWebhookSecretName: 'agentcore/default/github-webhook-secret'
 *   - cloudFrontGeoRestriction: ['JP', 'US']
 */
export const environments: Record<Environment, EnvironmentConfigInput> = {
  /**
   * Default environment
   */
  default: {
    cognitoDomainPrefix: 'mocauserpool57dde685', // Must be unique across all AWS accounts and regions
    customDomain: {
      hostName: 'moca',
      domainName: 'geeawa.net',
    },
  },
  /**
   * Development environment
   */
  dev: {
    cognitoDomainPrefix: 'mocadev-user-pool-1316',
  },

  /**
   * Staging environment
   */
  stg: {
    cognitoDomainPrefix: 'mocastg-<your-unique-suffix>',
    corsAllowedOrigins: ['https://stg.example.com'],
    memoryExpirationDays: 60,
    s3RemovalPolicy: cdk.RemovalPolicy.RETAIN,
    s3AutoDeleteObjects: false,
    logRetentionDays: 14,
    tavilyApiKeySecretName: 'agentcore/stg/tavily-api-key',
    githubTokenSecretName: 'agentcore/stg/github-token',
    githubWebhookSecretName: 'agentcore/stg/github-webhook-secret',
  },

  /**
   * Production environment
   */
  prd: {
    cognitoDomainPrefix: 'mocaprd-<your-unique-suffix>',
    deletionProtection: true,
    corsAllowedOrigins: ['https://app.example.com'],
    memoryExpirationDays: 365,
    s3RemovalPolicy: cdk.RemovalPolicy.RETAIN,
    s3AutoDeleteObjects: false,
    cognitoDeletionProtection: true,
    logRetentionDays: 30,
    tavilyApiKeySecretName: 'agentcore/prd/tavily-api-key',
    githubTokenSecretName: 'agentcore/prd/github-token',
    githubWebhookSecretName: 'agentcore/prd/github-webhook-secret',
  },
};
