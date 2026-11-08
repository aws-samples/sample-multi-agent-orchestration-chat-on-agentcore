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
    'Execute shell commands and return results. Can be used for file operations, information gathering, and development task automation.\n\n' +
    'Pre-installed for local web preview/testing (works with localhost servers you start here): headless Chromium on PATH as `chromium` ' +
    '(e.g. `chromium --screenshot=shot.png --window-size=1280,800 http://localhost:3000`, `chromium --dump-dom URL`), ' +
    "`playwright-core` resolvable from any directory (`require('playwright-core').chromium.launch()`), and Japanese/CJK + emoji fonts. " +
    'No install or download is needed.\n\n' +
    'Background processes (dev servers etc.) MUST redirect output, e.g. `python3 -m http.server 8000 > /tmp/server.log 2>&1 &`. ' +
    'Without it the process loses its stdout/stderr when this call returns and later requests get empty responses (ERR_EMPTY_RESPONSE) — this is not a network restriction.',
  zodSchema: executeCommandSchema,
  jsonSchema: zodToJsonSchema(executeCommandSchema),
};
