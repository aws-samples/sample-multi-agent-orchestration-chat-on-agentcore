import { z } from 'zod';
import { zodToJsonSchema } from '../utils/schema-converter.js';
import { GATEWAY_TOOL_NAMES, RUNTIME_TOOL_NAMES } from '../tool-names.js';
import type { ToolDefinition } from '../types.js';

const scenarioSchema = z.object({
  title: z.string().describe('Scenario title (e.g., "Code Review Request")'),
  prompt: z.string().describe('Prompt template for this scenario'),
});

export const manageAgentSchema = z.object({
  action: z
    .enum(['create', 'update', 'get'])
    .describe(
      "Action: 'create' to create new agent, 'update' to modify existing, 'get' to retrieve details"
    ),

  // Agent ID (required for update/get)
  agentId: z.string().optional().describe('Agent ID (required for update/get actions)'),

  // Agent configuration (required for create, optional for update)
  name: z.string().optional().describe('Agent name (e.g., "Code Reviewer", "Data Analyst")'),
  description: z.string().optional().describe('Brief description of what this agent does'),
  systemPrompt: z
    .string()
    .optional()
    .describe('System prompt that defines the agent behavior and capabilities'),
  enabledTools: z
    .array(z.string())
    .optional()
    .describe(
      `Array of tool names to enable (e.g., ["${RUNTIME_TOOL_NAMES.EXECUTE_COMMAND}", "${RUNTIME_TOOL_NAMES.FILE_EDITOR}", "${GATEWAY_TOOL_NAMES.TAVILY_SEARCH}"])`
    ),
  icon: z.string().optional().describe('Lucide icon name (e.g., "Bot", "Code", "Brain", "Search")'),
  scenarios: z
    .array(scenarioSchema)
    .optional()
    .describe('Predefined scenarios/prompts for quick access'),
});

export const manageAgentDefinition: ToolDefinition<typeof manageAgentSchema> = {
  name: RUNTIME_TOOL_NAMES.MANAGE_AGENT,
  description: `Create, update, or retrieve AI agent configurations.

**Available Actions:**
- 'create': Create a new agent with custom configuration
- 'update': Modify an existing agent's settings
- 'get': Retrieve details of a specific agent

**For 'create' action (required parameters):**
- name: Human-readable name for the agent
- description: What the agent does
- systemPrompt: Instructions that define agent behavior
- enabledTools: Which tools the agent can use
- icon (optional): Visual icon from Lucide icons
- scenarios (optional): Quick-access prompt templates

**For 'update' action:**
- agentId (required): ID of the agent to update
- Any combination of: name, description, systemPrompt, enabledTools, icon, scenarios
- Only provided fields will be updated (partial update supported)

**For 'get' action:**
- agentId (required): ID of the agent to retrieve

**Available Tools for enabledTools:**
- ${RUNTIME_TOOL_NAMES.EXECUTE_COMMAND}: Run shell commands
- ${RUNTIME_TOOL_NAMES.FILE_EDITOR}: Create and edit files
- ${GATEWAY_TOOL_NAMES.TAVILY_SEARCH}: Web search
- ${GATEWAY_TOOL_NAMES.TAVILY_EXTRACT}: Extract content from URLs
- ${GATEWAY_TOOL_NAMES.TAVILY_CRAWL}: Crawl websites
- ${RUNTIME_TOOL_NAMES.S3_LIST_FILES}: List S3 files
- ${RUNTIME_TOOL_NAMES.CODE_INTERPRETER}: Execute Python code
- ${GATEWAY_TOOL_NAMES.NOVA_CANVAS}: Generate images
- ${RUNTIME_TOOL_NAMES.IMAGE_TO_TEXT}: Analyze images
- ${RUNTIME_TOOL_NAMES.CALL_AGENT}: Invoke other agents
- ${GATEWAY_TOOL_NAMES.NOVA_REEL}: Generate videos
- ${RUNTIME_TOOL_NAMES.MANAGE_AGENT}: Manage agents

**Returns:**
- For create/update: agentId, name, success status
- For get: Full agent configuration`,
  zodSchema: manageAgentSchema,
  jsonSchema: zodToJsonSchema(manageAgentSchema),
};
