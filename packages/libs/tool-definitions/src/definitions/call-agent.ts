import { z } from 'zod';
import { zodToJsonSchema } from '../utils/schema-converter.js';
import type { ToolDefinition } from '../types.js';

export const callAgentSchema = z.object({
  action: z
    .enum(['list_agents', 'start_task', 'status'])
    .describe("Action: 'list_agents' to list, 'start_task' to start, 'status' to check"),

  // start_task parameters
  agentId: z
    .string()
    .optional()
    .describe('Agent ID (required for start_task, e.g., "web-researcher")'),
  query: z.string().optional().describe('Query to send to the agent (required for start_task)'),
  modelId: z
    .string()
    .regex(
      /^(global\.|us\.|eu\.|apac\.)?(anthropic\.|amazon\.|meta\.|mistral\.|cohere\.)[a-zA-Z0-9._:/-]+$/,
      'modelId must be a valid Bedrock model ID (e.g., "global.anthropic.claude-sonnet-4-6", "global.amazon.nova-2-lite-v1:0")'
    )
    .optional()
    .describe(
      'Model ID to use (optional, defaults to agent config). ' +
        'Must be a valid Bedrock model ID. Examples: ' +
        '"global.anthropic.claude-sonnet-4-6", ' +
        '"global.anthropic.claude-opus-4-6-v1", ' +
        '"global.amazon.nova-2-lite-v1:0"'
    ),
  storagePath: z
    .string()
    .optional()
    .describe(
      'S3 storage path for sub-agent (e.g., "/project-a/"). Inherits from parent if not specified.'
    ),
  sessionId: z
    .string()
    .optional()
    .describe(
      'Session ID for sub-agent conversation history. If not specified, auto-generated as "<33-char-alphanumeric>_subagent" (same format as regular user sessions).'
    ),

  // status parameters
  taskId: z.string().optional().describe('Task ID (required for status action)'),

  // Polling options (for status action)
  waitForCompletion: z
    .boolean()
    .default(false)
    .describe('Wait for completion with polling (default: false)'),
  pollingInterval: z.number().default(30).describe('Polling interval in seconds (default: 30)'),
  maxWaitTime: z.number().default(1200).describe('Max wait time in seconds (default: 1200)'),
});

export const callAgentDefinition: ToolDefinition<typeof callAgentSchema> = {
  name: 'call_agent',
  description: `Invoke specialized sub-agents asynchronously to handle specific tasks that require different expertise.

**Available Actions:**
- 'list_agents': Get list of available agents with their IDs and descriptions
- 'start_task': Start a new sub-agent task (returns taskId)
- 'status': Check task status (with optional polling until completion)

**To discover available agents:**
First use action='list_agents' to get the current list of agents with their agentIds.
Then use those agentIds with action='start_task' to invoke them.

**Usage Pattern:**
1. List agents: action='list_agents'
2. Start task: action='start_task', agentId='<agentId from list>', query='...'
3. Check status: action='status', taskId='task_xxx'
   - Set waitForCompletion=true to wait for results (with polling)
   - Set waitForCompletion=false for immediate status check

**Important:**
- Sub-agents run independently with no shared history
- Tasks can run for minutes or hours
- Use polling (waitForCompletion=true) for shorter tasks
- Use immediate checks (waitForCompletion=false) for long-running tasks`,
  zodSchema: callAgentSchema,
  jsonSchema: zodToJsonSchema(callAgentSchema),
};
