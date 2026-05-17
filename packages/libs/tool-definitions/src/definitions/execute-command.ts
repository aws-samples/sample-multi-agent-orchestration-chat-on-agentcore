import { z } from 'zod';
import { zodToJsonSchema } from '../utils/schema-converter.js';
import type { ToolDefinition } from '../types.js';

export const executeCommandSchema = z.object({
  command: z.string().describe('Shell command to execute'),
  workingDirectory: z
    .string()
    .optional()
    .describe('Working directory (current directory if not specified)'),
  timeout: z
    .number()
    .min(1000)
    .max(600000)
    .default(120000)
    .describe('Timeout in milliseconds (default: 120s, max: 600s)'),
  maxOutputLength: z
    .number()
    .min(1000)
    .max(1000000)
    .default(100000)
    .describe(
      'Max output length in characters (default: 100000, min: 1000, max: 1000000). Increase to retrieve full output for long-running commands.'
    ),
});

export const executeCommandDefinition: ToolDefinition<typeof executeCommandSchema> = {
  name: 'execute_command',
  description:
    'Execute shell commands and return results. Can be used for file operations, information gathering, and development task automation.',
  zodSchema: executeCommandSchema,
  jsonSchema: zodToJsonSchema(executeCommandSchema),
};
