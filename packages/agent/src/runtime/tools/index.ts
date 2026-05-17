export { executeCommandTool } from './execute-command.js';
export { createStrandsToolFromMCP, convertMCPToolsToStrands } from './mcp-converter.js';
export { codeInterpreterTool } from './code-interpreter/index.js';
export { s3ListFilesTool } from './s3-list-files.js';
export { fileEditorTool } from './file-editor.js';
export { imageToTextTool } from './image-to-text/index.js';
export { callAgentTool } from './call-agent.js';
export { manageAgentTool } from './manage-agent.js';
export { memorySearchTool } from './memory-search.js';
export { browserTool } from './browser/index.js';
export { todoTool } from './todo/index.js';
export { thinkTool } from './think.js';
export { generateUiTool } from './generate-ui/index.js';

// Import local tool array
import { executeCommandTool } from './execute-command.js';
import { codeInterpreterTool } from './code-interpreter/index.js';
import { s3ListFilesTool } from './s3-list-files.js';
import { fileEditorTool } from './file-editor.js';
import { imageToTextTool } from './image-to-text/index.js';
import { callAgentTool } from './call-agent.js';
import { manageAgentTool } from './manage-agent.js';
import { memorySearchTool } from './memory-search.js';
import { browserTool } from './browser/index.js';
import { todoTool } from './todo/index.js';
import { thinkTool } from './think.js';
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
