import { describe, it, expect } from '@jest/globals';
import { codeInterpreterTool } from '../tool.js';

/**
 * Behavior test for the code_interpreter tool's context-error path.
 *
 * When invoked outside any request scope, requireStoragePath() throws a
 * ToolContextError. The tool must surface that actionable message to the model
 * rather than burying it under the generic "An unexpected error occurred:"
 * header (the regression flagged in review).
 */
describe('codeInterpreterTool context error', () => {
  it('surfaces the ToolContextError message verbatim when no request context', async () => {
    const result = await codeInterpreterTool.invoke({
      action: 'listLocalSessions',
      sessionName: 'test-session',
    } as Parameters<typeof codeInterpreterTool.invoke>[0]);

    expect(typeof result).toBe('string');
    expect(result).toBe(
      'Request context is not available. The tool was invoked outside an active request.'
    );
    expect(result).not.toContain('An unexpected error occurred');
  });
});
