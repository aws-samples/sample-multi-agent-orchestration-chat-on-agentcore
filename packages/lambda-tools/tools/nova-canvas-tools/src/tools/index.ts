/**
 * Nova Canvas tools registry
 */

import { ToolRegistry } from '@moca/lambda-tools-shared';
import { novaCanvasTool } from './nova-canvas.js';

/**
 * Tool registry with Nova Canvas tool registered.
 * Default tool is `nova_canvas`.
 */
export const registry = new ToolRegistry([novaCanvasTool], novaCanvasTool);

/**
 * Get a tool handler by name (convenience wrapper)
 */
export function getToolHandler(toolName: string | null) {
  return registry.getHandler(toolName);
}
