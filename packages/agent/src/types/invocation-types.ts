/**
 * Type definitions for invocation requests
 */

import type { ReasoningDepth } from '@moca/core';
import type { ImageData } from './validation/image-validator.js';

/**
 * Agent invocation request type definition
 */
export interface InvocationRequest {
  prompt: string; // Required: User input
  modelId?: string; // Optional: Model ID to use (default: environment variable)
  reasoningEffort?: ReasoningDepth; // Optional: extended-thinking depth (off|low|high|max). Ignored for non-capable models.
  enabledTools?: string[]; // Optional: Array of tool names to enable (undefined=all, []=none)
  systemPrompt?: string; // Optional: Custom system prompt
  storagePath?: string; // Optional: S3 directory path selected by user
  agentId?: string; // Optional: Agent ID for session tracking
  memoryEnabled?: boolean; // Optional: Whether to enable long-term memory (default: false)
  memoryTopK?: number; // Optional: Number of long-term memories to retrieve (default: 10)
  mcpConfig?: Record<string, unknown>; // Optional: User-defined MCP server configuration
  images?: ImageData[]; // Optional: Array of images for multimodal input
  targetUserId?: string; // Optional: Target user ID for batch processing (machine user only)
  goal?: string; // Optional: Natural-language goal. When non-empty, enables the GoalLoop refinement plugin for this turn only.
  goalJudgeModelId?: string; // Optional: Model ID for the GoalLoop judge Agent. Falls back to GOAL_JUDGE_MODEL_ID when unset/invalid.
  goalMaxAttempts?: number; // Optional: GoalLoop attempt cap for this turn. Clamped to [GOAL_LOOP_ATTEMPTS_MIN, GOAL_LOOP_ATTEMPTS_MAX]; non-integers fall back to GOAL_LOOP_MAX_ATTEMPTS.
}
