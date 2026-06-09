import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_MAX_DEPTH,
  checkRecursionDepth,
  hasStartTaskParams,
  hasTaskId,
  validateStartTaskInput,
  validateStatusInput,
} from '../validation.js';

/**
 * Unit tests for the pure call_agent guards.
 *
 * These assert the EXACT error objects the model sees on each guidance path —
 * the user-facing contract — without touching the task-manager singleton, the
 * agent registry network call, or the request context.
 */
describe('validateStartTaskInput', () => {
  it('returns undefined when both agentId and query are present', () => {
    expect(validateStartTaskInput({ agentId: 'web-researcher', query: 'hi' })).toBeUndefined();
  });

  it('returns the missing-parameters error when agentId is absent', () => {
    expect(validateStartTaskInput({ query: 'hi' })).toEqual({
      error: 'Missing required parameters',
      message: 'agentId and query are required for start_task action',
    });
  });

  it('returns the missing-parameters error when query is absent', () => {
    expect(validateStartTaskInput({ agentId: 'web-researcher' })).toEqual({
      error: 'Missing required parameters',
      message: 'agentId and query are required for start_task action',
    });
  });

  it('treats an empty-string agentId or query as missing', () => {
    expect(validateStartTaskInput({ agentId: '', query: 'hi' })).toEqual({
      error: 'Missing required parameters',
      message: 'agentId and query are required for start_task action',
    });
    expect(validateStartTaskInput({ agentId: 'a', query: '' })).toEqual({
      error: 'Missing required parameters',
      message: 'agentId and query are required for start_task action',
    });
  });
});

describe('checkRecursionDepth', () => {
  it('returns undefined below the max depth', () => {
    expect(checkRecursionDepth(0, DEFAULT_MAX_DEPTH)).toBeUndefined();
    expect(checkRecursionDepth(1, DEFAULT_MAX_DEPTH)).toBeUndefined();
  });

  it('returns the recursion error at the max depth', () => {
    expect(checkRecursionDepth(DEFAULT_MAX_DEPTH, DEFAULT_MAX_DEPTH)).toEqual({
      error: 'Maximum recursion depth reached',
      message: `Cannot invoke sub-agent at depth ${DEFAULT_MAX_DEPTH}. Max depth is ${DEFAULT_MAX_DEPTH}.`,
      currentDepth: DEFAULT_MAX_DEPTH,
      maxDepth: DEFAULT_MAX_DEPTH,
    });
  });

  it('returns the recursion error beyond the max depth with the actual depth echoed', () => {
    expect(checkRecursionDepth(5, 2)).toEqual({
      error: 'Maximum recursion depth reached',
      message: 'Cannot invoke sub-agent at depth 5. Max depth is 2.',
      currentDepth: 5,
      maxDepth: 2,
    });
  });

  it('defaults the max depth to 2', () => {
    expect(DEFAULT_MAX_DEPTH).toBe(2);
  });
});

describe('validateStatusInput', () => {
  it('returns undefined when taskId is present', () => {
    expect(validateStatusInput({ taskId: 'task_123' })).toBeUndefined();
  });

  it('returns the missing-parameter error when taskId is absent', () => {
    expect(validateStatusInput({})).toEqual({
      error: 'Missing required parameter',
      message: 'taskId is required for status action',
    });
  });

  it('treats an empty-string taskId as missing', () => {
    expect(validateStatusInput({ taskId: '' })).toEqual({
      error: 'Missing required parameter',
      message: 'taskId is required for status action',
    });
  });
});

describe('hasStartTaskParams (type guard)', () => {
  it('is true only when both agentId and query are non-empty', () => {
    expect(hasStartTaskParams({ agentId: 'a', query: 'q' })).toBe(true);
  });

  it('is false when either is missing or empty', () => {
    expect(hasStartTaskParams({ query: 'q' })).toBe(false);
    expect(hasStartTaskParams({ agentId: 'a' })).toBe(false);
    expect(hasStartTaskParams({ agentId: '', query: 'q' })).toBe(false);
    expect(hasStartTaskParams({ agentId: 'a', query: '' })).toBe(false);
  });

  it('agrees with validateStartTaskInput (guard true ⇔ validate undefined)', () => {
    const inputs = [
      { agentId: 'a', query: 'q' },
      { query: 'q' },
      { agentId: '', query: 'q' },
    ];
    for (const input of inputs) {
      expect(hasStartTaskParams(input)).toBe(validateStartTaskInput(input) === undefined);
    }
  });
});

describe('hasTaskId (type guard)', () => {
  it('is true for a non-empty taskId', () => {
    expect(hasTaskId({ taskId: 't' })).toBe(true);
  });

  it('is false when taskId is missing or empty', () => {
    expect(hasTaskId({})).toBe(false);
    expect(hasTaskId({ taskId: '' })).toBe(false);
  });
});
