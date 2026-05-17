# Deployment Options

This guide explains how to customize your deployment by modifying `packages/cdk/config/environments.ts`.

## Overview

The Moca platform supports multiple deployment environments (default, dev, stg, prd) with customizable configurations. Each environment can have different settings for security, storage, logging, and integrations.

## Configuration File

Edit the environment configuration in `packages/cdk/config/environments.ts`:

```typescript
export const environments: Record<Environment, EnvironmentConfigInput> = {
  default: {
    // Minimal configuration - uses all defaults
  },
  dev: {
    // Development environment
    tavilyApiKeySecretName: 'agentcore/dev/tavily-api-key',
    githubTokenSecretName: 'agentcore/dev/github-token',
    allowedSignUpEmailDomains: ['example.com'],
  },
  stg: {
    // Staging environment
    corsAllowedOrigins: ['https://stg.example.com'],
    memoryExpirationDays: 60,
  },
  prd: {
    // Production environment with stricter settings
    deletionProtection: true,
    memoryExpirationDays: 365,
  },
};
```

## Available Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cognitoDomainPrefix` | string | **required** (non-PR envs) | Cognito User Pool domain prefix (globally unique across all AWS accounts/regions). PR envs auto-generate this. See [Cognito Domain Prefix](#cognito-domain-prefix). |
| `deletionProtection` | boolean | `false` | Stack deletion protection |
| `corsAllowedOrigins` | string[] | `['*']` | Allowed CORS origins |
| `memoryExpirationDays` | number | `30` | AgentCore Memory retention period (days) |
| `s3RemovalPolicy` | RemovalPolicy | `DESTROY` | S3 bucket removal policy |
| `s3AutoDeleteObjects` | boolean | `true` | Auto-delete S3 objects on stack deletion |
| `cognitoDeletionProtection` | boolean | `false` | Cognito User Pool deletion protection. When `false`, the UserPool, UserPoolDomain, and ResourceServer are destroyed together with the stack. |
| `logRetentionDays` | number | `7` | Lambda log retention period (days) |
| `tavilyApiKeySecretName` | string | `'agentcore/default/tavily-api-key'` | Secrets Manager secret name for Tavily API key |
| `githubTokenSecretName` | string | `'agentcore/default/github-token'` | Secrets Manager secret name for GitHub token |
| `githubWebhookSecretName` | string | `'agentcore/default/github-webhook-secret'` | Secrets Manager secret name for GitHub webhook HMAC secret |
| `allowedSignUpEmailDomains` | string[] | - | Allowed email domains for sign-up |
| `customDomain` | object | - | Custom domain configuration |
| `testUser` | object | - | Test user auto-creation (dev only) |
| `eventRules` | array | - | EventBridge rule configurations |
| `microsoftGraphOAuthProviderArn` | string | - | Microsoft Graph OAuth2 credential provider ARN |
| `microsoftGraphOAuthSecretArn` | string | - | Microsoft Graph OAuth2 secret ARN |
| `cloudFrontGeoRestriction` | string[] | `['JP', 'US']` | CloudFront geo restriction allowlist (ISO 3166-1 alpha-2 codes). Override to customize. |
| `awsAccount` | string | - | AWS Account ID (uses CDK_DEFAULT_ACCOUNT if not specified) |
| `resourcePrefix` | string | auto-generated | Resource name prefix (e.g., 'moca', 'mocadev') |
| `bedrockModels` | BedrockModelConfig[] | global.* models | Available Bedrock models for frontend model selector |
| `athenaSourceBuckets` | AthenaS3Source[] | - | S3 locations Athena Tools can read from. Each entry specifies a `bucket` name and an optional `prefix` to restrict access to a subfolder. **When not set, the Athena Tools Lambda target is not deployed.** |
| `knowledgeBaseIds` | string[] | - | Bedrock Knowledge Base IDs KB Tools can search. **When not set, the KB Tools Lambda target is not deployed.** |

## Environment Examples

### Development

Lightweight configuration for development and testing:

```typescript
dev: {
  // Cognito managed-login domain (globally unique — see Cognito Domain Prefix below)
  cognitoDomainPrefix: 'acme-moca-dev',

  // API integrations
  tavilyApiKeySecretName: 'agentcore/dev/tavily-api-key',
  githubTokenSecretName: 'agentcore/dev/github-token',
  
  // Restrict sign-up to specific domains
  allowedSignUpEmailDomains: ['your-company.com'],
  
  // Short retention for cost savings
  memoryExpirationDays: 7,
  logRetentionDays: 3,
},
```

### Production

Secure configuration with data retention and security hardening:

```typescript
prd: {
  // Cognito managed-login domain (globally unique — see Cognito Domain Prefix below)
  cognitoDomainPrefix: 'acme-moca-prd',

  // Enable deletion protection
  deletionProtection: true,
  cognitoDeletionProtection: true,
  
  // Retain data on stack deletion
  s3RemovalPolicy: cdk.RemovalPolicy.RETAIN,
  s3AutoDeleteObjects: false,
  
  // Extended retention
  memoryExpirationDays: 365,
  logRetentionDays: 30,
  
  // Restrict CORS
  corsAllowedOrigins: ['https://app.your-domain.com'],
  
  // API integrations
  tavilyApiKeySecretName: 'agentcore/prd/tavily-api-key',
  githubTokenSecretName: 'agentcore/prd/github-token',

  // cloudFrontGeoRestriction defaults to ['JP', 'US'] - override if needed
  // Note: Cognito PLUS tier + Threat Protection and WAF WebACL are always enabled
},
```

### Staging

Security-hardened staging configuration:

```typescript
stg: {
  // Cognito managed-login domain (globally unique — see Cognito Domain Prefix below)
  cognitoDomainPrefix: 'acme-moca-stg',

  corsAllowedOrigins: ['https://stg.your-domain.com'],
  s3RemovalPolicy: cdk.RemovalPolicy.RETAIN,
  s3AutoDeleteObjects: false,
  logRetentionDays: 14,
  // cloudFrontGeoRestriction defaults to ['JP', 'US'] - override if needed
  // Note: Cognito PLUS tier + Threat Protection and WAF WebACL are always enabled
},
```

> **Note:** AWS WAF WebACL (`{stackName}Waf` stack in `us-east-1`) is automatically deployed for all environments. The CloudFront distribution references the WAF ARN via CDK cross-region references.

### Custom Domain Example

To use a custom domain for the frontend:

```typescript
dev: {
  customDomain: {
    hostName: 'agents',        // Creates: agents.example.com
    domainName: 'example.com', // Route53 hosted zone
  },
},
```

**Requirements:**
- A Route53 public hosted zone must exist in the same AWS account
- ACM certificate will be automatically created and validated

### Event Rules Example

Define EventBridge rules for event-driven agent triggers.

> **Note:** The `icon` field specifies the icon displayed in the application UI. Available icons can be found at [Lucide Icons](https://lucide.dev/icons/).

```typescript
dev: {
  eventRules: [
    {
      id: 's3-upload',
      name: 'S3 File Upload',
      description: 'Triggered when a file is uploaded to S3',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: {
            name: [{ prefix: 'moca-user-storage-' }],
          },
        },
      },
      icon: 'cloud-upload', // https://lucide.dev/icons/cloud-upload
      enabled: true,
    },
    {
        id: 'github-issue-created',
        name: 'GitHub Issue created',
        description: 'Triggered when a new issue is opened in the GitHub repository',
        eventPattern: {
          source: ['github.com'],
          detailType: ['issues'],
          detail: {
            action: ['opened'],
          },
        },
        icon: 'github', // https://lucide.dev/icons/github
        enabled: true,
    },
    {
        id: 'github-pr',
        name: 'GitHub Pull Request',
        description: 'Triggered when a pull request event occurs in the GitHub repository',
        eventPattern: {
          source: ['github.com'],
          detailType: ['pull_request'],
        },
        icon: 'git-pull-request', // https://lucide.dev/icons/git-pull-request
        enabled: true,
    },
  ],
},
```

## Cognito Domain Prefix

`cognitoDomainPrefix` is a **required** configuration for non-PR environments. It sets the Cognito User Pool managed-login domain used for the OAuth2 token endpoint:

```
https://{cognitoDomainPrefix}.auth.{region}.amazoncognito.com/oauth2/token
```

This endpoint is used by the Machine User client credentials flow (Trigger Lambda and CLI).

### Constraints

Enforced by `validateCognitoDomainPrefix` at `cdk synth` time:

- 3–63 characters
- Lowercase alphanumeric and hyphens only
- Must not start with `aws`, `amazon`, or `cognito`
- Must not start or end with a hyphen
- **Globally unique across all AWS accounts and regions** — the Cognito domain namespace is shared worldwide. Include an organization-specific identifier (e.g. `acme-moca-dev`) to avoid collisions.

### PR Environments

PR environments (`pr-{n}`) **auto-generate** the prefix as `moca-pr-{n}-{last-4-of-account-id}`. No manual configuration is required; however, `CDK_DEFAULT_ACCOUNT` must resolve to a 12-digit account ID at synth time (i.e. run `cdk` with valid AWS credentials).

### Changing the Prefix on an Existing Deployment

Changing `cognitoDomainPrefix` triggers a Replacement of `AWS::Cognito::UserPoolDomain` (CFN Update requires: Replacement). Because a User Pool can only attach one domain at a time, CloudFormation may fail with `"Invalid request provided: AWS::Cognito::UserPoolDomain"` if the old domain is still attached. Delete the old domain manually before redeploying:

```bash
aws cognito-idp delete-user-pool-domain \
  --domain <old-prefix> \
  --user-pool-id <pool-id> \
  --region <region>
```

The User Pool ID can be found in the stack output `UserPoolId` or in the AWS Cognito console.

## Bedrock Model Selection

You can configure which Bedrock models are available in the frontend model selector per environment. Each model ID should include the [cross-region inference profile](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html) prefix (e.g., `global.`, `us.`, `eu.`, `apac.`, `jp.`).

```typescript
dev: {
  bedrockModels: [
    { id: 'us.anthropic.claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'Anthropic' },
    { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', name: 'Claude Haiku 4.5', provider: 'Anthropic' },
    { id: 'us.amazon.nova-2-lite-v1:0', name: 'Nova Lite 2', provider: 'Amazon' },
  ],
},
```

If `bedrockModels` is not specified, the frontend defaults to `global.*` prefixed models (Claude Opus 4.6, Claude Sonnet 4.6, Nova Lite 2). The first model in the list is used as the default selection.

## Deploying Different Environments

```bash
# Deploy default environment
npm run deploy

# Deploy development environment
npm run deploy:dev

# Deploy staging environment
npm run deploy:stg

# Deploy production environment
npm run deploy:prd
```

## System Agent Seeding

After deploying a new environment, seed the default system agents into DynamoDB. These agents appear in the shared agents directory for all users.

```bash
# Seed system agents (auto-detects table name from CloudFormation)
npm run seed-system-agents -- --env dev
```

### Options

| Option | Description |
|--------|-------------|
| `--env <dev\|stg\|prd>` | Environment name (required) |
| `--region <region>` | AWS region (default: `ap-northeast-1`) |
| `--table <name>` | DynamoDB table name (auto-detected from CloudFormation if omitted) |
| `--force` | Delete existing system agents and re-seed |
| `--dry-run` | Preview changes without writing to DynamoDB |

### Examples

```bash
# Preview what would be seeded
npm run seed-system-agents -- --env dev --dry-run

# Re-seed after updating DEFAULT_AGENTS definitions
npm run seed-system-agents -- --env prd --force

# Specify table name directly (when CloudFormation access is unavailable)
npm run seed-system-agents -- --env dev --table mocadev-agents
```

> **Note:** This is a one-time operation per environment. The script is idempotent — if system agents already exist, it skips unless `--force` is specified.


## Microsoft Graph (OneDrive) Integration

Enable OneDrive file operations and Excel workbook manipulation through Microsoft Graph API. When configured, agents can list, upload, download, search, and manage files in OneDrive, as well as read and write Excel worksheets, cells, and ranges.

### Prerequisites

1. **Azure AD App Registration** — Register an application in [Microsoft Entra admin center](https://entra.microsoft.com/)
2. **API Permissions** — Add Microsoft Graph Application permission `Files.ReadWrite.All` and grant admin consent
3. **Client Secret** — Create a client secret for the registered application

### 1. Create OAuth2 Credential Provider

Create an OAuth2 credential provider in the AgentCore Identity management console:

1. Open the **AgentCore console** → **Identity** → **Token Vault**
2. Create a new **OAuth2 Credential Provider** with:
   - **Authorization URL**: `https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/authorize`
   - **Token URL**: `https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/token`
   - **Client ID**: Your Azure AD application (client) ID
   - **Client Secret**: Your Azure AD client secret
   - **Scope**: `https://graph.microsoft.com/.default`
3. Note the **Credential Provider ARN** and the auto-generated **Secret ARN** from the output

### 2. Configure Environment

Add the ARNs to your environment configuration in `packages/cdk/config/environments.ts`:

```typescript
dev: {
  microsoftGraphOAuthProviderArn:
    'arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/tv-xxx/oauth2credentialprovider/microsoft-graph',
  microsoftGraphOAuthSecretArn:
    'arn:aws:secretsmanager:us-east-1:123456789012:secret:AgentCoreTokenVault-xxx',
},
```

### 3. Deploy

```bash
npm run deploy
```

After deployment, the OneDrive OpenAPI gateway target is automatically created. Agents can then use OneDrive tools for file and Excel operations.

## GitHub Webhook Setup

To receive GitHub events (Issues, Pull Requests) and trigger agents automatically:

### 1. Create Webhook Secret in Secrets Manager

```bash
# Generate a random secret
WEBHOOK_SECRET=$(uuidgen)

# Store in Secrets Manager
aws secretsmanager create-secret \
  --name "agentcore/dev/github-webhook-secret" \
  --secret-string "$WEBHOOK_SECRET" \
  --region ap-northeast-1

echo "Save this secret for GitHub configuration: $WEBHOOK_SECRET"
```

### 2. Configure GitHub Repository Webhook

1. Go to your GitHub repository → **Settings** → **Webhooks** → **Add webhook**
2. Set the following:
   - **Payload URL**: `<Backend API URL>/webhooks/github` (find in CloudFormation outputs)
   - **Content type**: `application/json`
   - **Secret**: The `$WEBHOOK_SECRET` value from step 1
   - **Events**: Select "Let me select individual events" → check **Issues** and **Pull requests**
3. Click **Add webhook**

### 3. Create Event Triggers

In the Moca UI, create triggers that subscribe to the `github-issue-created` or `github-pr` event sources. When a matching GitHub event occurs, the subscribed agent will be automatically invoked with the event context.

## Knowledge Base Tools Integration

Enable semantic search against Amazon Bedrock Knowledge Bases. This feature is **opt-in** — the KB Tools Lambda target is only deployed when `knowledgeBaseIds` is explicitly configured.

### Why opt-in?

Without `knowledgeBaseIds`, deploying KB Tools would require `bedrock:Retrieve` on `knowledge-base/*` (all Knowledge Bases in the account). By requiring an explicit ID list, IAM permissions are scoped to only the KBs you intend to expose.

### Configuration

Add the Knowledge Base IDs to your environment configuration:

```typescript
dev: {
  knowledgeBaseIds: [
    'ABCDEF1234',  // e.g., product documentation KB
    'GHIJKL5678',  // e.g., internal wiki KB
  ],
},
```

After deployment, agents can use the `kb-retrieve` tool to run semantic searches against the configured Knowledge Bases.

### What gets deployed

When `knowledgeBaseIds` is set, the following resources are created in the `AgentCoreGatewayTargetStack`:

- **KB Tools Lambda** — Gateway target exposing the `kb-retrieve` tool
- **IAM policy** — `bedrock:Retrieve` scoped to the specified Knowledge Base ARNs only

### Notes

- Knowledge Base IDs can be found in the [Amazon Bedrock console](https://console.aws.amazon.com/bedrock/) → **Knowledge bases**
- The `knowledgeBaseId` parameter is passed at runtime by the agent — all configured KBs are accessible

## Athena Tools Integration

Enable SQL query capabilities via Amazon Athena. This feature is **opt-in** — the Athena Tools Lambda target is only deployed when `athenaSourceBuckets` is explicitly configured.

### Why opt-in?

Without `athenaSourceBuckets`, deploying Athena Tools would require `s3:GetObject` on `Resource: *` (all S3 buckets in the account), which is a high-risk wildcard permission. By requiring an explicit bucket list, IAM permissions are scoped to only the data you intend to query.

### Configuration

Add the S3 locations that back your Glue Data Catalog tables. Each entry specifies a bucket name and an optional prefix to restrict IAM access to a specific subfolder:

```typescript
dev: {
  athenaSourceBuckets: [
    // Grant access to the entire bucket
    { bucket: 'my-data-lake-bucket' },

    // Grant access only to a specific folder within the bucket
    {
      bucket: 'analytics-data-988417841316-ap-northeast-1',
      prefix: 'analytics/meti_data_business_potential/',
    },
  ],
},
```

When `prefix` is specified, IAM object-level access is scoped to `s3://bucket/prefix/*` — only objects under that path are accessible. The bucket ARN itself is still included to allow `s3:ListBucket` and `s3:GetBucketLocation`.

After deployment, agents can use Athena Tools to run SQL queries against any Glue-catalogued table whose data resides in the configured locations.

### What gets deployed

When `athenaSourceBuckets` is set, the following resources are created in the `AgentCoreGatewayTargetStack`:

- **Athena Tools Lambda** — Gateway target that executes SQL queries via Athena
- **Athena Output S3 Bucket** — Temporary bucket for Athena query results (7-day lifecycle)
- **IAM policies** — Scoped to `workgroup/primary`, configured source buckets, and Glue catalog

### Notes

- Queries are executed using the `primary` Athena workgroup
- Query results are stored in the output bucket with a 7-day expiration
- Only Glue Data Catalog databases and tables are accessible (no direct S3 path queries)

## Related Documentation

- [Local Development Setup](./local-development-setup.md)
