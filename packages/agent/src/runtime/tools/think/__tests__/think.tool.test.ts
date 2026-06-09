import { describe, expect, it } from '@jest/globals';
import { thinkTool } from '../index.js';

/**
 * Behavior tests for the think handler.
 *
 * The handler is exercised through `defineTool`'s `invoke()` seam. The think
 * tool has no request context and no error path — it always acknowledges the
 * thought with a fixed string.
 */
describe('thinkTool', () => {
  it('exposes the public tool name', () => {
    expect(thinkTool.name).toBe('think');
  });

  it('returns the exact acknowledgment string', async () => {
    const result = await thinkTool.invoke({
      thought: 'Step 1: analyze the tool result. Step 2: decide next action.',
    });

    expect(result).toBe('Thought recorded. Continue with your next action.');
  });

  it('acknowledges an empty thought without error', async () => {
    const result = await thinkTool.invoke({ thought: '' });

    expect(result).toBe('Thought recorded. Continue with your next action.');
  });
});
