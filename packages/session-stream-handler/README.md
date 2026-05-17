# Session Stream Handler

DynamoDB Streams handler for session events. This Lambda function processes stream events from the Sessions table and publishes them to AppSync Events API for real-time updates.

## Overview

```
DynamoDB Streams → Lambda → AppSync Events → WebSocket → Frontend
```

When sessions are created, modified, or deleted, this handler:
1. Receives the DynamoDB Stream event
2. Parses the session data
3. Signs the request using IAM credentials (SigV4)
4. Publishes to the AppSync Events API
5. Frontend receives the event via WebSocket subscription

## Event Types

| Event Type | Description |
|------------|-------------|
| `INSERT` | New session created |
| `MODIFY` | Session updated (e.g., title changed) |
| `REMOVE` | Session deleted |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `APPSYNC_HTTP_ENDPOINT` | AppSync Events HTTP endpoint for publishing |
| `AWS_REGION` | AWS region |

## Channel Format

Events are published to user-specific channels:
```
/sessions/{userId}
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Lint
npm run lint
```

## Deployment

This Lambda is deployed via CDK as part of the AgentCore stack. See `packages/cdk/lib/constructs/session-stream-handler.ts`.

## IAM Permissions

The Lambda requires:
- `appsync:EventPublish` on the AppSync Events API
- `dynamodb:GetRecords`, `dynamodb:GetShardIterator`, `dynamodb:DescribeStream`, `dynamodb:ListStreams` on the Sessions table stream
