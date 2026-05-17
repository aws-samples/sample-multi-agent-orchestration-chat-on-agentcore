# @moca/lambda-tools-shared

Shared utilities for AgentCore Gateway Lambda Tools.

## Overview

This package provides the common infrastructure for building Lambda functions that serve as [AgentCore Gateway](https://docs.aws.amazon.com/bedrock/latest/userguide/agentcore-gateway.html) targets. Each Lambda is invoked directly via the **Lambda Invoke API** (not API Gateway), so there are no HTTP-layer concerns like status codes, headers, or CORS.

```
AgentCore Gateway
  │
  ├─ Lambda Invoke ──► utility-tools Lambda
  │                      └─ uses @moca/lambda-tools-shared
  │
  └─ Lambda Invoke ──► athena-tools Lambda
                         └─ uses @moca/lambda-tools-shared
```

## Modules

| Module | Description |
|---|---|
| `handler-factory.ts` | Lambda handler factory. Manages the request lifecycle: context parsing → tool resolution → execution → response building. |
| `types.ts` | Core type definitions: `AgentCoreRequest`, `AgentCoreResponse`, `ToolInput`, `ToolResult`. |
| `tool-types.ts` | Tool definition types (`Tool`, `ToolHandler`) and error classes (`ToolError`, `ToolValidationError`, `AccessDeniedError`). |
| `tool-registry.ts` | `ToolRegistry` class for managing available tools with name-based lookup and tag-based search. |
| `context-parser.ts` | Extracts the tool name from the Lambda execution context (`clientContext.custom.bedrockAgentCoreToolName`). |
| `logger.ts` | Structured JSON logger with automatic request ID injection and log level filtering via `LOG_LEVEL` env var. |

## Usage

### Creating a new tool

1. Define a tool handler function and a `Tool` object:

```typescript
import { ToolInput, ToolResult, Tool, ToolValidationError } from '@moca/lambda-tools-shared';

async function handleMyTool(input: ToolInput): Promise<ToolResult> {
  const { param } = input as { param?: string };
  if (!param) {
    throw new ToolValidationError("'param' is required", 'my-tool', 'param');
  }
  return { output: `Processed: ${param}` };
}

export const myTool: Tool = {
  name: 'my-tool',
  handler: handleMyTool,
  description: 'Does something useful',
  version: '1.0.0',
  tags: ['custom'],
};
```

2. Register it in a `ToolRegistry` and wire up the handler:

```typescript
import { ToolRegistry, createHandler, AgentCoreResponse, ToolInput } from '@moca/lambda-tools-shared';
import { Context } from 'aws-lambda';
import { myTool } from './tools/my-tool.js';

const registry = new ToolRegistry([myTool], myTool);

export const handler: (event: ToolInput, context: Context) => Promise<AgentCoreResponse> =
  createHandler({
    getToolHandler: (name) => registry.getHandler(name),
    defaultToolName: myTool.name,
  });
```

3. Add the tool schema to `tool-schema.json`:

```json
{
  "tools": [
    {
      "name": "my-tool",
      "description": "Does something useful",
      "inputSchema": {
        "type": "object",
        "properties": {
          "param": { "type": "string", "description": "Input parameter" }
        },
        "required": ["param"]
      }
    }
  ]
}
```

### Response format

The handler factory returns an `AgentCoreResponse` object directly (no HTTP wrapping):

```typescript
// Success
{
  result: { /* tool output */ },
  metadata: { timestamp, requestId, toolName }
}

// Error
{
  result: null,
  error: "Error message",
  metadata: { timestamp, requestId, toolName }
}
```

### Logging

The `logger` singleton outputs single-line JSON logs with automatic request ID injection:

```typescript
import { logger } from '@moca/lambda-tools-shared';

logger.info('MY_TAG', { key: 'value' });
// Output: [MY_TAG] {"reqId":"...","key":"value"}
```

Log level is controlled by the `LOG_LEVEL` environment variable (`DEBUG` | `INFO` | `WARN` | `ERROR`). Default: `INFO`.

## Build

```bash
npm run build   # Compile TypeScript to dist/
npm run clean   # Remove dist/