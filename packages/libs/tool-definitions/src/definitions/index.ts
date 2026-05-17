export * from './execute-command.js';
export * from './file-editor.js';
export * from './s3-list-files.js';
export * from './code-interpreter.js';
export * from './image-to-text.js';
export * from './call-agent.js';
export * from './manage-agent.js';
export * from './memory-search.js';
export * from './browser.js';
export * from './todo.js';
export * from './think.js';
export * from './generate-ui.js';

import { executeCommandDefinition } from './execute-command.js';
import { fileEditorDefinition } from './file-editor.js';
import { s3ListFilesDefinition } from './s3-list-files.js';
import { codeInterpreterDefinition } from './code-interpreter.js';
import { imageToTextDefinition } from './image-to-text.js';
import { callAgentDefinition } from './call-agent.js';
import { manageAgentDefinition } from './manage-agent.js';
import { memorySearchDefinition } from './memory-search.js';
import { browserDefinition } from './browser.js';
import { todoDefinition } from './todo.js';
import { thinkDefinition } from './think.js';
import { generateUiDefinition } from './generate-ui.js';

/**
 * All tool definitions array
 */
export const allToolDefinitions = [
  executeCommandDefinition,
  fileEditorDefinition,
  s3ListFilesDefinition,
  codeInterpreterDefinition,
  imageToTextDefinition,
  callAgentDefinition,
  manageAgentDefinition,
  memorySearchDefinition,
  browserDefinition,
  todoDefinition,
  thinkDefinition,
  generateUiDefinition,
];

/**
 * MCP format (JSON Schema) tool definitions
 */
export const allMCPToolDefinitions = allToolDefinitions.map((def) => ({
  name: def.name,
  description: def.description,
  inputSchema: def.jsonSchema,
}));
