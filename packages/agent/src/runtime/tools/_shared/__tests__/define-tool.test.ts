import { describe, it, expect } from '@jest/globals';
import { thinkDefinition } from '@moca/tool-definitions';
import { defineTool } from '../define-tool.js';
import { ToolContextError } from '../tool-context.js';

describe('defineTool', () => {
  it('exposes the definition name and returns the handler result on success', async () => {
    const t = defineTool(thinkDefinition, async (input) => `echo:${input.thought}`);
    expect(t.name).toBe('think');
    await expect(t.invoke({ thought: 'hi' })).resolves.toBe('echo:hi');
  });

  it('surfaces a ToolContextError message verbatim', async () => {
    const t = defineTool(thinkDefinition, async () => {
      throw new ToolContextError('Please log in again.');
    });
    await expect(t.invoke({ thought: 'x' })).resolves.toBe('Please log in again.');
  });

  it('normalizes a generic Error into a prefixed message', async () => {
    const t = defineTool(thinkDefinition, async () => {
      throw new Error('boom');
    });
    await expect(t.invoke({ thought: 'x' })).resolves.toBe(
      'An error occurred while running think: boom'
    );
  });

  it('normalizes a non-Error thrown value', async () => {
    const t = defineTool(thinkDefinition, async () => {
      throw 'string failure';
    });
    await expect(t.invoke({ thought: 'x' })).resolves.toBe(
      'An error occurred while running think: string failure'
    );
  });
});
