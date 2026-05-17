/**
 * Nova Reel tools registry
 */

import { ToolRegistry } from '@moca/lambda-tools-shared';
import { novaReelTool } from './nova-reel.js';

/**
 * Tool registry with Nova Reel tool registered.
 * Default tool is `nova_reel`.
 */
export const registry = new ToolRegistry([novaReelTool], novaReelTool);

/**
 * Get a tool handler by name (convenience wrapper)
 */
export function getToolHandler(toolName: string | null) {
  return registry.getHandler(toolName);
}
