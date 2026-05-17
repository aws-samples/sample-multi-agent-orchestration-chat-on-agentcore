import { z } from 'zod';
import { zodToJsonSchema } from '../utils/schema-converter.js';
import type { ToolDefinition } from '../types.js';

export const memorySearchSchema = z.object({
  query: z
    .string()
    .describe(
      'Semantic search query to find relevant long-term memories about the user. ' +
        'Examples: "preferred programming language", "past projects", "communication style preferences"'
    ),
  topK: z
    .number()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of memory records to retrieve (1-50, default: 10)'),
});

export const memorySearchDefinition: ToolDefinition<typeof memorySearchSchema> = {
  name: 'memory_search',
  description:
    'Search long-term memory for information about the current user. ' +
    'Retrieves past knowledge, preferences, habits, and context from previous conversations ' +
    'using semantic search against AgentCore Memory. ' +
    'Use this when you need to recall user-specific information that may not be in the current conversation context. ' +
    "The search is scoped to the current user only — you cannot access other users' memories. " +
    'Note: Some memories are already loaded at session start and included in the system prompt. ' +
    'Use this tool when you need to search for additional or more specific memories mid-conversation.',
  zodSchema: memorySearchSchema,
  jsonSchema: zodToJsonSchema(memorySearchSchema),
};
