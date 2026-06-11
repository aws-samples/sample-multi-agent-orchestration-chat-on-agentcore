/**
 * Unit tests for the memory_search tool definition (schema + JSON Schema).
 *
 * Covers the multi-mode shape added on top of the original semantic-search
 * tool: the `mode` enum, the `read_session` `range` window, the
 * `list_sessions` pagination params, and that the Zod 4 → JSON Schema
 * conversion surfaces enum/array constraints correctly.
 */

import {
  memorySearchDefinition,
  memorySearchSchema,
  READ_SESSION_MAX_MESSAGES,
} from '../definitions/memory-search';

describe('memory_search tool definition', () => {
  it('has the correct tool name', () => {
    expect(memorySearchDefinition.name).toBe('memory_search');
  });

  it('caps read_session at 20 messages per call', () => {
    expect(READ_SESSION_MAX_MESSAGES).toBe(20);
  });

  describe('JSON Schema (model-facing)', () => {
    const props = memorySearchDefinition.jsonSchema.properties as Record<
      string,
      Record<string, unknown>
    >;

    it('exposes a mode enum with all three modes', () => {
      expect(props.mode.type).toBe('string');
      expect(props.mode.enum).toEqual(['search', 'list_sessions', 'read_session']);
      expect(props.mode.default).toBe('search');
    });

    it('exposes query/topK for search mode', () => {
      expect(props.query.type).toBe('string');
      expect(props.topK.type).toBe('number');
      expect(props.topK.minimum).toBe(1);
      expect(props.topK.maximum).toBe(50);
    });

    it('exposes limit/nextToken for list_sessions mode', () => {
      expect(props.limit.type).toBe('number');
      expect(props.limit.minimum).toBe(1);
      expect(props.limit.maximum).toBe(100);
      expect(props.nextToken.type).toBe('string');
    });

    it('exposes sessionId/range for read_session mode', () => {
      expect(props.sessionId.type).toBe('string');
      expect(props.range.type).toBe('array');
      expect((props.range.items as Record<string, unknown>).type).toBe('number');
    });

    it('marks no field as required (all modes share one optional surface)', () => {
      // `mode` has a default and every other field is optional, so the schema
      // intentionally has no top-level required fields; per-mode requirements
      // are enforced by the handler.
      expect(memorySearchDefinition.jsonSchema.required).toBeUndefined();
    });
  });

  describe('Zod schema (server-side validation)', () => {
    it('defaults mode to "search" when omitted', () => {
      const parsed = memorySearchSchema.parse({ query: 'hello' });
      expect(parsed.mode).toBe('search');
      expect(parsed.topK).toBe(10);
    });

    it('accepts a valid list_sessions input', () => {
      const result = memorySearchSchema.safeParse({
        mode: 'list_sessions',
        limit: 10,
        nextToken: 'abc',
      });
      expect(result.success).toBe(true);
    });

    it('accepts a valid read_session input with a 2-element range', () => {
      const result = memorySearchSchema.safeParse({
        mode: 'read_session',
        sessionId: 's-1',
        range: [0, 20],
      });
      expect(result.success).toBe(true);
    });

    it('rejects a range that is not exactly two elements', () => {
      const result = memorySearchSchema.safeParse({
        mode: 'read_session',
        sessionId: 's-1',
        range: [0],
      });
      expect(result.success).toBe(false);
    });

    it('rejects negative range indices', () => {
      const result = memorySearchSchema.safeParse({
        mode: 'read_session',
        sessionId: 's-1',
        range: [-1, 5],
      });
      expect(result.success).toBe(false);
    });

    it('rejects an unknown mode', () => {
      const result = memorySearchSchema.safeParse({ mode: 'delete_session' });
      expect(result.success).toBe(false);
    });
  });

  it('is included in allToolDefinitions and allMCPToolDefinitions', async () => {
    const { allToolDefinitions, allMCPToolDefinitions } = await import('../definitions/index');
    expect(allToolDefinitions.find((d) => d.name === 'memory_search')).toBeDefined();
    const mcp = allMCPToolDefinitions.find((d) => d.name === 'memory_search');
    expect(mcp?.inputSchema).toEqual(memorySearchDefinition.jsonSchema);
  });
});
