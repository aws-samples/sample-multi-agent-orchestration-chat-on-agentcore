/**
 * Shared building blocks for local tools.
 *
 * `defineTool` applies the common error-handling policy; the context helpers
 * concentrate request-context validation. Tool folders depend on this barrel,
 * never on the individual files.
 */

export { defineTool, type ToolHandler } from './define-tool.js';
export {
  ToolContextError,
  requireUserId,
  requireStoragePath,
  requireIdentityId,
} from './tool-context.js';
