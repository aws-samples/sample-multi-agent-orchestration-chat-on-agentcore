import { ToolRegistry } from '@moca/lambda-tools-shared';
import { pegasusVideoToTextTool } from './pegasus-video-to-text.js';

export const registry = new ToolRegistry([pegasusVideoToTextTool], pegasusVideoToTextTool);
export function getToolHandler(toolName: string | null) {
  return registry.getHandler(toolName);
}
