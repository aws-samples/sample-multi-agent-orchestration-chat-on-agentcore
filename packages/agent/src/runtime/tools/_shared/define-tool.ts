/**
 * defineTool — narrow factory for string-returning local tools
 *
 * Wraps the SDK `tool()` so that every local tool shares one locus for the
 * cross-cutting concerns each used to repeat inline:
 *
 * - the outermost `try / catch` around the handler,
 * - error normalization (`Error` vs unknown thrown value),
 * - `ToolContextError` handling (its message is surfaced verbatim to the model),
 * - structured error logging.
 *
 * A tool author writes only the happy path:
 *
 *   export const fooTool = defineTool(fooDefinition, async (input, context) => {
 *     const userId = requireUserId();
 *     // ...
 *     return 'result text';
 *   });
 *
 * Tools whose return value is not a string (e.g. `generate_ui` returning a JSON
 * string envelope, or `call_agent` returning an object) are intentionally NOT
 * built with this factory — see the runtime/tools refactor plan.
 */

import { tool, type ToolContext } from '@strands-agents/sdk';
import { z } from 'zod';
import type { ToolDefinition } from '@moca/tool-definitions';
import { logger } from '../../../libs/logger/index.js';
import { ToolContextError } from './tool-context.js';

/**
 * Handler implementing a tool's happy path. Throwing is expected for error
 * cases — `defineTool` catches and formats the result. Throw a
 * {@link ToolContextError} to surface an actionable message to the model.
 */
export type ToolHandler<T extends ToolDefinition> = (
  input: z.infer<T['zodSchema']>,
  context?: ToolContext
) => Promise<string>;

/**
 * Format a thrown value into the string returned to the model.
 *
 * `ToolContextError` messages are intended to be user-facing and are returned
 * as-is; any other error is normalized to a generic, prefixed message.
 */
function formatToolError(toolName: string, error: unknown): string {
  if (error instanceof ToolContextError) {
    logger.warn({ tool: toolName, err: error.message }, `Tool context error: ${toolName}`);
    return error.message;
  }

  const message = error instanceof Error ? error.message : String(error);
  logger.error({ tool: toolName, err: message }, `Tool execution error: ${toolName}`);
  return `An error occurred while running ${toolName}: ${message}`;
}

/**
 * Build a Strands tool from a `ToolDefinition` and a string-returning handler,
 * applying the shared error-handling policy.
 */
export function defineTool<T extends ToolDefinition>(definition: T, handler: ToolHandler<T>) {
  return tool({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.zodSchema,
    callback: async (input, context) => {
      try {
        return await handler(input as z.infer<T['zodSchema']>, context);
      } catch (error) {
        return formatToolError(definition.name, error);
      }
    },
  });
}
