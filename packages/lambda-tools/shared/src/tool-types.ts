/**
 * Tool definition types and error classes for AgentCore Gateway Lambda Tools
 */

import { ToolInput, ToolResult } from './types.js';

/**
 * Tool handler function signature
 */
export type ToolHandler = (input: ToolInput) => Promise<ToolResult>;

/**
 * Tool definition structure
 */
export interface Tool {
  /** Tool name */
  name: string;
  /** Tool handler function */
  handler: ToolHandler;
  /** Tool description */
  description?: string;
  /** Tool version */
  version?: string;
  /** Tool tags for categorization */
  tags?: string[];
}

/**
 * Tool execution context metadata
 */
export interface ToolExecutionContext {
  /** Execution start time (epoch ms) */
  startTime: number;
  /** Tool name */
  toolName: string;
  /** Input data size in bytes */
  inputSize: number;
}

/**
 * Tool execution result with metadata
 */
export interface ToolExecutionResult {
  /** Execution result */
  result: ToolResult;
  /** Execution context */
  context: ToolExecutionContext;
  /** Execution duration in milliseconds */
  executionTimeMs: number;
  /** Output data size in bytes */
  outputSize: number;
}

/**
 * Base tool error
 */
export class ToolError extends Error {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * Input validation error
 */
export class ToolValidationError extends ToolError {
  constructor(
    message: string,
    toolName: string,
    public readonly field?: string
  ) {
    super(message, toolName);
    this.name = 'ToolValidationError';
  }
}

/**
 * Access denied error (e.g., resource not in allow list)
 */
export class AccessDeniedError extends ToolError {
  constructor(
    message: string,
    toolName: string,
    public readonly resource?: string
  ) {
    super(message, toolName);
    this.name = 'AccessDeniedError';
  }
}
