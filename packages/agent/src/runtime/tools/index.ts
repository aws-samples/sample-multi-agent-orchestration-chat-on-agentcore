export { executeCommandTool } from './execute-command/index.js';
export { createStrandsToolFromMCP, convertMCPToolsToStrands } from './mcp-converter.js';
export { codeInterpreterTool } from './code-interpreter/index.js';
export { s3ListFilesTool } from './s3-list-files/index.js';
export { fileEditorTool } from './file-editor/index.js';
export { imageToTextTool } from './image-to-text/index.js';
export { callAgentTool } from './call-agent/index.js';
export { manageAgentTool } from './manage-agent/index.js';
export { memorySearchTool } from './memory-search/index.js';
export { browserTool } from './browser/index.js';
export { todoTool } from './todo/index.js';
export { thinkTool } from './think/index.js';
export { generateUiTool } from './generate-ui/index.js';

// Import local tool array
import { executeCommandTool } from './execute-command/index.js';
import { codeInterpreterTool } from './code-interpreter/index.js';
import { s3ListFilesTool } from './s3-list-files/index.js';
import { fileEditorTool } from './file-editor/index.js';
import { imageToTextTool } from './image-to-text/index.js';
import { callAgentTool } from './call-agent/index.js';
import { manageAgentTool } from './manage-agent/index.js';
import { memorySearchTool } from './memory-search/index.js';
import { browserTool } from './browser/index.js';
import { todoTool } from './todo/index.js';
import { thinkTool } from './think/index.js';
import { generateUiTool } from './generate-ui/index.js';

/**
 * List of local tools built into the Agent
 * Add new tools here
 *
 * Note: nova_canvas, nova_reel, and tavily_* have been migrated to Lambda tools
 * (Gateway Targets). They are now invoked via AgentCore Gateway and no longer
 * need to be in this list.
 */
export const localTools = [
  executeCommandTool,
  codeInterpreterTool,
  s3ListFilesTool,
  fileEditorTool,
  imageToTextTool,
  callAgentTool,
  manageAgentTool,
  memorySearchTool,
  browserTool,
  todoTool,
  thinkTool,
  generateUiTool,
];
