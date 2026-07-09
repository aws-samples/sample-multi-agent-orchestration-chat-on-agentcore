/**
 * OpenAI gpt-image tools registry
 */

import { ToolRegistry } from '@moca/lambda-tools-shared';
import { gptImageTool } from './gpt-image.js';
import { gptImageEditTool } from './gpt-image-edit.js';

/**
 * Tool registry with the gpt-image generate + edit tools registered.
 * Default tool is `gpt_image` (text-to-image).
 */
export const registry = new ToolRegistry([gptImageTool, gptImageEditTool], gptImageTool);

/**
 * Get a tool handler by name (convenience wrapper)
 */
export function getToolHandler(toolName: string | null) {
  return registry.getHandler(toolName);
}
