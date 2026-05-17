/**
 * @moca/lambda-tools-shared — Shared utilities for AgentCore Gateway Lambda Tools
 *
 * Barrel export for all shared modules.
 */

// Type definitions
export type {
  ToolInput,
  ToolResult,
  ResponseMetadata,
  AgentCoreRequest,
  AgentCoreResponse,
} from './types.js';

// Tool definition types and error classes
export type { ToolHandler, Tool, ToolExecutionContext, ToolExecutionResult } from './tool-types.js';
export { ToolError, ToolValidationError, AccessDeniedError } from './tool-types.js';

// Logger
export { logger } from './logger.js';

// Context parser
export { extractToolName, extractActualToolName, getContextSummary } from './context-parser.js';

// Tool registry
export { ToolRegistry } from './tool-registry.js';
export type { RegistryStats } from './tool-registry.js';

// Handler factory
export { createHandler } from './handler-factory.js';
export type { HandlerConfig } from './handler-factory.js';
