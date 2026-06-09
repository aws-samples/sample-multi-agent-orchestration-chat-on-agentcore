import { describe, it, expect } from '@jest/globals';
import { browserTool } from '../tool.js';

/**
 * Behavior test for the browser tool's context-error path.
 *
 * Invoked outside any request scope, requireStoragePath() throws a
 * ToolContextError. The tool must surface that actionable message verbatim
 * rather than wrapping it in the generic "Browser Error:" prefix.
 */
describe('browserTool context error', () => {
  it('surfaces the ToolContextError message verbatim when no request context', async () => {
    const result = await browserTool.invoke({
      action: 'getSessionStatus',
    } as Parameters<typeof browserTool.invoke>[0]);

    expect(typeof result).toBe('string');
    expect(result).toBe(
      'Request context is not available. The tool was invoked outside an active request.'
    );
    expect(result).not.toContain('Browser Error');
  });
});
