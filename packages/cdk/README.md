# CDK

AWS CDK stack for deploying Amazon Bedrock AgentCore across multiple environments.

## Quick Start

### 1. Bootstrap (first-time only)

```bash
npx -w packages/cdk cdk bootstrap
```

### 2. Deploy

```bash
npm run deploy:dev   # Development
npm run deploy:stg   # Staging
npm run deploy:prd   # Production (requires approval)
```

Configuration: `config/environments.ts`

