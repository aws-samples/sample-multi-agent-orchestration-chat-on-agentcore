# @moca/trigger

Event-driven trigger Lambda for invoking AgentCore agents on schedule or custom events.

## Overview

This Lambda function handles EventBridge events to automatically invoke Agent API endpoints. It routes incoming events to the appropriate handler based on event type:

- **Schedule Triggers**: Cron or rate-based schedules via EventBridge Scheduler
- **Custom Event Triggers**: EventBridge Rules from S3, GitHub, Slack, etc.

When invoked, the Lambda automatically appends event context information after the user's prompt, allowing agents to understand they are running in an automated, event-driven mode. The agent's system prompt remains unchanged.

## Architecture

```
EventBridge Scheduler ─┐
                       ├→ Trigger Lambda → Agent API (/invocations)
EventBridge Rules ─────┘       ↓
                        DynamoDB (execution history)
```

### Components

| Component | File | Description |
|-----------|------|-------------|
| **Entry Point** | `src/index.ts` | Routes events to schedule or custom event handler |
| **Schedule Handler** | `src/handlers/schedule-handler.ts` | Handles EventBridge Scheduler events |
| **Custom Event Handler** | `src/handlers/custom-event-handler.ts` | Handles EventBridge Rule events, fan-out to subscribed triggers |
| **Prompt Builder** | `src/services/prompt-builder.ts` | Appends event context to user prompt |
| **Agent Invoker** | `src/services/agent-invoker.ts` | HTTP POST to AgentCore Runtime (fire-and-forget) |
| **Auth Service** | `src/services/auth-service.ts` | Machine User authentication via Cognito |
| **Execution Recorder** | `src/services/execution-recorder.ts` | Records execution history in DynamoDB |

## Features

- ✅ EventBridge Scheduler integration (cron/rate)
- ✅ Custom EventBridge Rule integration (fan-out to subscribed triggers)
- ✅ Event context injection into user prompt (appended after user prompt)
- ✅ Machine User authentication (Client Credentials flow)
- ✅ Fire-and-forget agent invocation (AgentCore processes server-side)
- ✅ Execution history tracking in DynamoDB (30-day TTL)

## Event-Driven Prompt

When an agent is invoked via event, the **user prompt** is automatically enhanced with event context:

```
┌─────────────────────────────────────┐
│  Original user prompt               │
├─────────────────────────────────────┤
│  ---                                │
├─────────────────────────────────────┤
│  Event Context (auto-appended)      │
│  - Execution metadata               │
│  - EventBridge fields               │
│  - Event payload (JSON)             │
│  - Execution guidelines             │
└─────────────────────────────────────┘
```

The agent's **system prompt** is passed through from DynamoDB unchanged, keeping a clean separation between agent personality/role and event context.

### Example Prompt Output

For a schedule event, the agent receives:

```markdown
Generate today's sales report

---

## Event-Driven Execution Context

This agent is being invoked automatically in response to an event.
No human user is waiting in real-time.

### Execution Information

| Field | Value |
|-------|-------|
| Trigger | Daily Report Generator |
| Execution Time | 2026-01-17T00:00:00Z |
| Event Source | aws.scheduler |
| Event Type | Scheduled Event |
| Region | ap-northeast-1 |
| Event ID | event-abc-123 |

### Event Payload

```json
{
  "triggerId": "epB5aPbTjrFGymD3ws9q3",
  "userId": "47547a38-...",
  "agentId": "43a0a96c-...",
  "prompt": "Generate today's sales report"
}
```

### Guidelines for Event-Driven Execution

- Complete the assigned task thoroughly
- Document results and findings clearly
- Handle errors gracefully with explicit logging
- Do not ask clarifying questions - make reasonable assumptions and proceed
- Focus on reliability over speed
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `AGENT_API_URL` | Agent API endpoint URL | Yes |
| `COGNITO_USER_POOL_ID` | Cognito User Pool ID | Yes |
| `COGNITO_CLIENT_ID` | Machine User Client ID | Yes |
| `COGNITO_CLIENT_SECRET` | Machine User Client Secret | Yes |
| `TRIGGERS_TABLE_NAME` | DynamoDB table name | Yes |
| `AWS_REGION` | AWS Region | Yes |

## Event Payload

### EventBridge Scheduler Event

```json
{
  "version": "0",
  "id": "event-id",
  "detail-type": "Scheduled Event",
  "source": "aws.scheduler",
  "account": "123456789012",
  "time": "2024-01-15T00:00:00Z",
  "region": "ap-northeast-1",
  "resources": ["arn:aws:scheduler:..."],
  "detail": {
    "triggerId": "trigger-123",
    "userId": "user-456",
    "agentId": "agent-789",
    "prompt": "Execute daily task",
    "sessionId": "session-abc",
    "modelId": "anthropic.claude-sonnet-4-20250514-v1:0",
    "enabledTools": ["s3-list-files", "execute-command"]
  }
}
```

## Development

```bash
npm install   # Install dependencies
npm run build # Build
npm test      # Run tests
npm run dev   # Local development
```

This package is deployed as an AWS Lambda function via CDK. See `packages/cdk` for infrastructure configuration.

## Error Handling

Errors are handled at multiple levels:

1. **Service Initialization**: Fails fast if environment variables are missing
2. **Execution Recording**: Returns 500 if unable to create execution record
3. **Authentication**: Logged and recorded in execution history
4. **Agent API**: Captured and recorded in execution history
5. **Unexpected Errors**: Caught and recorded with full error details

All errors are logged to CloudWatch Logs and recorded in DynamoDB execution history.

## Execution History

Execution records are stored in DynamoDB with 30-day TTL auto-cleanup:

```typescript
{
  PK: "TRIGGER#{triggerId}",
  SK: "EXECUTION#{executionId}",
  triggerId: string,
  executionId: string,
  userId: string,
  startedAt: string,
  completedAt?: string,
  status: "running" | "completed" | "failed",
  requestId?: string,
  sessionId?: string,
  error?: string,
  ttl: number
}
```

