Language: [English](./README.md) / [Japanese](./README-ja.md)

# ☕ Multi-agent Orchestration Chat on AgentCore

A multi-agent orchestration chat platform built on Amazon Bedrock AgentCore.

## Overview

This is a multi-agent platform that enables teams to **create and customize** AI agents and share them across your organization. Built on Amazon Bedrock AgentCore, you can easily build agents tailored to your needs.

Preset agents are also available for immediate use, covering various domains including software development, data analysis, and content creation.

<div align="center">
  <table>
    <tr>
      <td width="50%">
        <img src="./docs/assets/agentchat.geeawa.net_chat.png" alt="Chat Interface" width="100%">
        <p align="center"><b>Agent Chat</b><br/>You can interact with specialized AI agents through a simple UI</p>
      </td>
      <td width="50%">
        <img src="./docs/assets/agentchat.geeawa.net_chat_share_agent.png" alt="Agent Sharing" width="100%">
        <p align="center"><b>Share Agent</b><br/>You can discover and share custom agents across your team</p>
      </td>
    </tr>
    <tr>
      <td width="50%">
        <img src="./docs/assets/agentchat.geeawa.net_event_integration.png" alt="Event Integration" width="100%">
        <p align="center"><b>Event-Driven Automation</b><br/>Trigger agents automatically via schedules and external events</p>
      </td>
      <td width="50%">
        <img src="./docs/assets/agentchat.geeawa.net_tools.png" alt="Tools" width="100%">
        <p align="center"><b>Extensible Tools</b><br/>Add and configure tools to extend agent capabilities</p>
      </td>
    </tr>
  </table>
</div>

### Key Highlights

- **Custom Agent Creation** - You can design and build agents freely according to your needs
- **Organization-Wide Sharing** - You can discover and share agents across your team
- **Preset Agents** - Ready-to-use agents including Software Developer, Data Analyst, Physicist, and more
- **Extensible Tools** - Supports command execution, web search, image generation, and external service integration
- **File Storage** - Includes built-in cloud storage for documents and resources
- **Enterprise Ready** - Supports JWT authentication, session management, and AWS Cognito integration
- **Memory and Context** - Recognizes persistent conversation history and context

## Architecture

This application uses a fully serverless architecture built on Amazon Bedrock AgentCore. User requests flow from the React frontend through Cognito authentication to the AgentCore Runtime, which orchestrates AI agent execution with tool integration via the AgentCore Gateway.

<br>

<div align="center">
  <img src="./docs/moca-architecture.drawio.png" alt="Architecture Diagram" width="100%">
</div>

<br>

### Tech Stack

| Layer | Services |
|-------|----------|
| Frontend | CloudFront + S3 (React SPA) |
| Auth | Amazon Cognito (JWT) |
| API | Lambda + API Gateway (Express.js) |
| Agent | AgentCore Runtime + Gateway + Memory + CodeInterpreter + Browser|
| Storage | DynamoDB + S3 |
| Real-time | AppSync Events (WebSocket) |
| Events | EventBridge Scheduler + Rules |

The backend API is responsible for agent management, session persistence, and file operations. AgentCore Runtime executes agents using the Strands Agents SDK (TypeScript), with short-term memory (session history) for conversational context and long-term memory (persistent memory) enabled. Real-time streaming is achieved via AppSync Events, allowing agents to be automatically executed by schedule triggers.

## Deployment

<details>
<summary><strong>Prerequisites</strong></summary>

The following environment is required for deployment.

- **Node.js 22.12.0+** - Version management with [n](https://github.com/tj/n) is recommended. See `.node-version`.
- **AWS CLI** - Must be configured with appropriate credentials.

</details>

### Deploy to AWS

#### 1. Install dependencies

First, install the dependencies.

```bash
npm ci
```

#### 2. Configure Secrets (Optional)

If needed, store API keys and tokens in AWS Secrets Manager for your target environment.

**Tavily API Key** (for web search tools)

```bash
aws secretsmanager create-secret \
  --name "agentcore/default/tavily-api-key" \
  --secret-string "tvly-your-api-key-here" \
  --region ap-northeast-1
```

You can get your API key from [Tavily](https://tavily.com/).

**GitHub Token** (for GitHub CLI integration)

```bash
aws secretsmanager create-secret \
  --name "agentcore/default/github-token" \
  --secret-string "ghp_your-token-here" \
  --region ap-northeast-1
```

You can generate a token from [GitHub Settings](https://github.com/settings/tokens).

**GitHub Webhook Secret** (for receiving GitHub webhook events)

```bash
aws secretsmanager create-secret \
  --name "agentcore/default/github-webhook-secret" \
  --secret-string "$(uuidgen)" \
  --region ap-northeast-1
```

This secret is used to verify HMAC-SHA256 signatures on incoming GitHub webhooks. See [GitHub Webhook Setup](docs/deployment-options.md#github-webhook-setup) for full configuration instructions.

For local development, you can also set these as environment variables in `packages/agent/.env`.

#### 3. Bootstrap CDK (first time only)

For the first deployment, run CDK bootstrap.

```bash
npx -w packages/cdk cdk bootstrap
```

#### 4. Configure environment

Before deploying, edit `packages/cdk/config/environments.ts` and set a globally unique `cognitoDomainPrefix` for each environment you plan to deploy. This prefix becomes part of the Cognito managed-login URL (`https://{prefix}.auth.{region}.amazoncognito.com`) and must be unique across **all AWS accounts worldwide** — include an organization-specific identifier to avoid collisions.

```typescript
// packages/cdk/config/environments.ts
default: {
  cognitoDomainPrefix: 'moca-<your-unique-suffix>', // ← replace with your own value
  // ...
},
```

See [Cognito Domain Prefix](docs/deployment-options.md#cognito-domain-prefix) for details.

#### 5. Deploy the stack

Deploy the stack with the following commands.

```bash
npm run deploy
```

#### 6. Create a Cognito user

Self sign-up is disabled by default. After deployment, you need to create a user in the Cognito User Pool before you can log in.

We recommend creating users through the **AWS Management Console**.

1. Open the [Amazon Cognito console](https://console.aws.amazon.com/cognito/).
2. Select the User Pool that matches the `UserPoolId` in the CloudFormation stack outputs.
3. Go to the **Users** tab and click **Create user**.
4. Enter a username, email, and password. 

You can then log in to the frontend URL (see the `WebAppFrontendUrl` stack output) with the created credentials.

> If you want to enable self sign-up from the app, set `selfSignUpEnabled: true` in `packages/cdk/config/environments.ts` and optionally specify `allowedSignUpEmailDomains`.

<details>
<summary>Create a user via AWS CLI (optional)</summary>

See the `CreateTestUserCommand` / `SetUserPasswordCommand` CloudFormation stack outputs, or run the following commands directly:

```bash
# 1. Create the user (no email verification)
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId> \
  --username <your-username> \
  --message-action SUPPRESS \
  --region <region>

# 2. Set a permanent password (skip forced change at first login)
aws cognito-idp admin-set-user-password \
  --user-pool-id <UserPoolId> \
  --username <your-username> \
  --password <YourPassword123!> \
  --permanent \
  --region <region>
```

</details>

#### 7. Seed system agents (Optional)

After deployment, seed the default system agents into DynamoDB. This is a one-time operation that populates the shared agents directory with the built-in agents.

```bash
npm run seed-system-agents -- --env default
```

To update system agents after changing `DEFAULT_AGENTS` definitions, use `--force` to replace existing ones:

```bash
npm run seed-system-agents -- --env default --force
```

After deployment, you can find the Frontend URL in the CloudFormation stack outputs.

For advanced configuration options such as custom domains, environment-specific settings, and event rules, see the [Deployment Options](docs/deployment-options.md) documentation.


## Cost

The following table provides a cost breakdown for deploying this system in the **ap-northeast-1 (Tokyo)** region for one month.

Here we assume **100 chat sessions per month** using the default model (**Claude Sonnet 4.6**, ~5 turns/session). The monthly cost is proportional to the number of sessions. (e.g. If you only run 50 sessions/month, multiply it with 50/100.)

| AWS service | Dimensions | Cost [USD/month] |
|-------------|------------|------------------:|
| Bedrock | Input: Sonnet 4.6, 100K tokens/session | 30.00 |
| Bedrock | Input (cache write): Sonnet 4.6, 10K tokens/session | 3.75 |
| Bedrock | Input (cache read): Sonnet 4.6, 80K tokens/session | 2.40 |
| Bedrock | Output: Sonnet 4.6, 15K tokens/session | 22.50 |
| AgentCore | Runtime Memory: 24 GB-Hours/session | 22.68 |
| AgentCore | Runtime vCPU: 0.08 vCPU-Hours/session | 0.72 |
| AgentCore | Short-Term Memory: 36 events/session | 0.90 |
| AgentCore | Long-Term Memory Storage: 2 memories/session | 0.15 |
| AgentCore | Long-Term Memory Retrieval: 1.3 queries/session | 0.07 |
| AgentCore | Gateway: 2 invocations/session | 0.001 |
| DynamoDB | Read: ~800 RRU/session, Write: ~200 WRU/session | 0.14 |
| S3 | Storage: ~10 GB (user files) | 0.50 |
| Cognito | 11 MAU (Essentials tier) | 0.40 |
| AppSync | ~20 operations/session | 0.12 |
| API Gateway | ~10 requests/session | 0.02 |
| Lambda | ~30 invocations/session, 128MB, 1s avg | < 0.01 |
| CloudFront | ~300 requests/day | < 0.01 |
| **TOTAL** | | **~84** |

Additionally, when the system is not in use (i.e., no active chat sessions), the ongoing costs are minimal (~$1/month for DynamoDB, S3, and Cognito base charges only). There are no upfront or fixed costs for compute.

## Documentation

### Technical Documentation
- [Deployment Options](docs/deployment-options.md) - Environment configuration and customization
- [Local Development Setup](docs/local-development-setup.md) - Explains environment setup automation

## Contributing

Contributions are welcome. Please feel free to submit a Pull Request.

---

# Disclaimer

This application is **not designed for production use**. Please treat it as a proof-of-concept (PoC) for exploring AI agent use cases. It is not intended to support usage by more than a few hundred users.

In addition, please be mindful of the information you input into this system. Inputs are processed and stored across multiple AWS services (Amazon Bedrock, AgentCore, DynamoDB, S3, CloudWatch Logs, etc.), and it is the deployer's responsibility to handle that information appropriately.

# Security
Note: this asset represents a proof-of-value for the services included and is not intended as a production-ready solution. You must determine how the AWS Shared Responsibility applies to their specific use case and implement the needed controls to achieve their desired security outcomes. AWS offers a broad set of security tools and configurations to enable our customers. This repository is an experimental sample application and may be updated without considering backward compatibility. 

Ultimately it is your responsibility as the developer of a full stack application to ensure all of its aspects are secure. We provide security best practices in repository documentation and provide a secure baseline but Amazon holds no responsibility for the security of applications built from this tool.
