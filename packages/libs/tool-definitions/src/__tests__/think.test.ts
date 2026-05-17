/**
 * Unit tests for Think tool definition
 */

import { thinkDefinition } from '../definitions/think';

describe('Think Tool Definition', () => {
  it('should have correct tool name', () => {
    expect(thinkDefinition.name).toBe('think');
  });

  it('should have description mentioning thinking through problems', () => {
    expect(thinkDefinition.description).toContain('think through a problem');
  });

  it('should have a thought parameter in the JSON schema', () => {
    const jsonSchema = thinkDefinition.jsonSchema;
    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.properties).toHaveProperty('thought');
    expect(jsonSchema.required).toContain('thought');
  });

  it('should have thought parameter of type string', () => {
    const thoughtProp = thinkDefinition.jsonSchema.properties['thought'] as Record<string, unknown>;
    expect(thoughtProp.type).toBe('string');
  });

  it('should have thought parameter with a description', () => {
    const thoughtProp = thinkDefinition.jsonSchema.properties['thought'] as Record<string, unknown>;
    expect(thoughtProp.description).toBeDefined();
    expect(typeof thoughtProp.description).toBe('string');
    expect((thoughtProp.description as string).length).toBeGreaterThan(0);
  });

  it('should only have the thought parameter (no extra params)', () => {
    const properties = Object.keys(thinkDefinition.jsonSchema.properties);
    expect(properties).toEqual(['thought']);
  });

  it('should be included in allToolDefinitions', async () => {
    const { allToolDefinitions } = await import('../definitions/index');
    const thinkDef = allToolDefinitions.find((def) => def.name === 'think');
    expect(thinkDef).toBeDefined();
  });

  it('should be included in allMCPToolDefinitions', async () => {
    const { allMCPToolDefinitions } = await import('../definitions/index');
    const thinkMCP = allMCPToolDefinitions.find((def) => def.name === 'think');
    expect(thinkMCP).toBeDefined();
    expect(thinkMCP?.inputSchema).toEqual(thinkDefinition.jsonSchema);
  });

  it('should have valid Zod schema that parses correctly', () => {
    const validInput = { thought: 'This is a test thought.' };
    const result = thinkDefinition.zodSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('should reject input without thought', () => {
    const invalidInput = {};
    const result = thinkDefinition.zodSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
  });

  it('should reject input with non-string thought', () => {
    const invalidInput = { thought: 123 };
    const result = thinkDefinition.zodSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
  });
});
