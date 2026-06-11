import { z } from 'zod';
import { zodToJsonSchema } from '../utils/schema-converter.js';
import { GATEWAY_TOOL_NAMES, RUNTIME_TOOL_NAMES } from '../tool-names.js';
import type { ToolDefinition } from '../types.js';

/**
 * Schedule config. `expression` is an EventBridge Scheduler cron/rate
 * expression that controls when the trigger fires. Cron uses the 6-field
 * EventBridge format (`minute hour day-of-month month day-of-week year`), e.g.
 * `0 0 * * ? *` (every day at 00:00). The minimum interval the Backend accepts
 * is 10 minutes. `schedulerArn`/`scheduleGroupName` are managed by the Backend
 * and must not be supplied here. Additive keys are passed through to match the
 * Backend's permissive scheduleConfig schema.
 */
const scheduleConfigSchema = z
  .object({
    expression: z
      .string()
      .describe(
        'EventBridge cron/rate expression, e.g. "0 0 * * ? *" (every day 00:00) or "rate(1 hour)". 6-field cron. Minimum interval is 10 minutes.'
      ),
    timezone: z
      .string()
      .optional()
      .describe('IANA timezone, e.g. "Asia/Tokyo". Defaults to UTC when omitted.'),
  })
  .passthrough();

export const manageTriggerSchema = z.object({
  action: z
    .enum(['create', 'update', 'get', 'list'])
    .describe(
      "Action: 'create' a new schedule trigger, 'update' an existing one, 'get' a single trigger, 'list' the caller's triggers"
    ),

  // Trigger ID (required for update/get)
  triggerId: z.string().optional().describe('Trigger ID (required for update/get actions)'),

  // Trigger configuration (required for create, optional for update)
  name: z.string().optional().describe('Human-readable trigger name'),
  description: z.string().optional().describe('Brief description of what this trigger does'),
  agentId: z.string().optional().describe('ID of the agent to invoke when the schedule fires'),
  prompt: z.string().optional().describe('Prompt passed to the agent on invocation'),
  scheduleConfig: scheduleConfigSchema
    .optional()
    .describe('Schedule config; expression (cron/rate) is required for schedule triggers'),
  enabledTools: z
    .array(z.string())
    .optional()
    .describe(
      `Array of tool names the invoked agent may use (e.g. ["${RUNTIME_TOOL_NAMES.EXECUTE_COMMAND}", "${GATEWAY_TOOL_NAMES.TAVILY_SEARCH}"])`
    ),
  modelId: z.string().optional().describe('Model ID override for the invocation (optional)'),
  workingDirectory: z
    .string()
    .optional()
    .describe('Working directory for the invoked agent (optional)'),
});

export const manageTriggerDefinition: ToolDefinition<typeof manageTriggerSchema> = {
  name: RUNTIME_TOOL_NAMES.MANAGE_TRIGGER,
  description: `Create, update, retrieve, or list schedule triggers that invoke an agent on a cron/rate schedule.

**Available Actions:**
- 'create': Create a new schedule trigger
- 'update': Modify an existing trigger (partial update)
- 'get': Retrieve a single trigger by id
- 'list': List the caller's triggers

**For 'create' action (required parameters):**
- name: Human-readable trigger name
- agentId: Which agent to invoke (use the call_agent tool's 'list_agents' action to discover valid agentIds)
- prompt: Prompt passed to the agent
- scheduleConfig.expression: EventBridge cron/rate expression controlling when it fires
- enabledTools, modelId, workingDirectory (optional)

**Schedule expression format (EventBridge):**
- Cron uses 6 fields: \`minute hour day-of-month month day-of-week year\`
- Examples: \`0 0 * * ? *\` = every day 00:00; \`0 9 * * ? *\` = every day 09:00; \`0 8 ? * MON-FRI *\` = weekdays 08:00; \`rate(1 hour)\` = hourly
- Set scheduleConfig.timezone (e.g. "Asia/Tokyo") for local-time schedules; defaults to UTC
- Minimum interval is 10 minutes — more frequent schedules are rejected

**Important:** Newly created triggers are always disabled (enabled=false). A human must
enable them via the Triggers UI before they start firing. This tool cannot enable, disable,
or delete triggers.

**For 'update' action:**
- triggerId (required): ID of the trigger to update
- Any combination of: name, description, agentId, prompt, scheduleConfig, enabledTools, modelId, workingDirectory
- Only provided fields are updated (partial update). The enabled state is never changed by this tool.

**For 'get' action:**
- triggerId (required): ID of the trigger to retrieve

**Returns:**
- For create/update/get: the trigger configuration
- For list: an array of triggers`,
  zodSchema: manageTriggerSchema,
  jsonSchema: zodToJsonSchema(manageTriggerSchema),
};
