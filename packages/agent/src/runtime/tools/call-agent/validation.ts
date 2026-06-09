/**
 * Pure validation / guard helpers for the call_agent tool.
 *
 * Each helper returns the EXACT error object the model would see when the
 * pre-condition is not satisfied, or `undefined` when the input is acceptable.
 * Keeping these pure (no I/O, no singletons) makes the guidance/error strings
 * deterministically testable.
 */

/**
 * Default maximum sub-agent recursion depth.
 */
export const DEFAULT_MAX_DEPTH = 2;

/**
 * Type guard: both `agentId` and `query` are present (non-empty) for
 * `start_task`. Generic so narrowing preserves the input's other fields
 * (`modelId`, `storagePath`, `sessionId`) — the call site needs no non-null
 * assertions.
 */
export function hasStartTaskParams<T extends { agentId?: string; query?: string }>(
  input: T
): input is T & { agentId: string; query: string } {
  return Boolean(input.agentId) && Boolean(input.query);
}

/**
 * Validate the required parameters for the `start_task` action.
 *
 * @returns the error object when `agentId` or `query` is missing, otherwise
 *   `undefined`.
 */
export function validateStartTaskInput(input: {
  agentId?: string;
  query?: string;
}): Record<string, unknown> | undefined {
  if (!hasStartTaskParams(input)) {
    return {
      error: 'Missing required parameters',
      message: 'agentId and query are required for start_task action',
    };
  }
  return undefined;
}

/**
 * Guard against exceeding the sub-agent recursion depth.
 *
 * @returns the error object when `currentDepth >= maxDepth`, otherwise
 *   `undefined`.
 */
export function checkRecursionDepth(
  currentDepth: number,
  maxDepth: number
): Record<string, unknown> | undefined {
  if (currentDepth >= maxDepth) {
    return {
      error: 'Maximum recursion depth reached',
      message: `Cannot invoke sub-agent at depth ${currentDepth}. Max depth is ${maxDepth}.`,
      currentDepth,
      maxDepth,
    };
  }
  return undefined;
}

/**
 * Type guard: `taskId` is present (non-empty) for the `status` action. Generic
 * so narrowing preserves the input's other fields; the call site needs no
 * non-null assertions.
 */
export function hasTaskId<T extends { taskId?: string }>(
  input: T
): input is T & { taskId: string } {
  return Boolean(input.taskId);
}

/**
 * Validate the required parameter for the `status` action.
 *
 * @returns the error object when `taskId` is missing, otherwise `undefined`.
 */
export function validateStatusInput(input: {
  taskId?: string;
}): Record<string, unknown> | undefined {
  if (!hasTaskId(input)) {
    return {
      error: 'Missing required parameter',
      message: 'taskId is required for status action',
    };
  }
  return undefined;
}
