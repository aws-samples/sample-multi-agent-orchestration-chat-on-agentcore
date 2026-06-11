/**
 * Unit tests for zodToJsonSchema, guarding the Zod 4 internal-shape handling
 * (enum members via `.options`, array element via `_def.element`, and
 * string/number constraints via `_zod.def`). These shapes differ from Zod 3,
 * so these tests fail loudly if the dependency regresses or is downgraded.
 */

import { z } from 'zod';
import { zodToJsonSchema } from '../utils/schema-converter';

describe('zodToJsonSchema (Zod 4 internals)', () => {
  it('converts string min/max length constraints', () => {
    const schema = z.object({ name: z.string().min(2).max(8) });
    const name = zodToJsonSchema(schema).properties.name as Record<string, unknown>;
    expect(name.type).toBe('string');
    expect(name.minLength).toBe(2);
    expect(name.maxLength).toBe(8);
  });

  it('converts number minimum/maximum constraints', () => {
    const schema = z.object({ topK: z.number().min(1).max(50) });
    const topK = zodToJsonSchema(schema).properties.topK as Record<string, unknown>;
    expect(topK.type).toBe('number');
    expect(topK.minimum).toBe(1);
    expect(topK.maximum).toBe(50);
  });

  it('converts enum members via .options', () => {
    const schema = z.object({ mode: z.enum(['a', 'b', 'c']) });
    const mode = zodToJsonSchema(schema).properties.mode as Record<string, unknown>;
    expect(mode.type).toBe('string');
    expect(mode.enum).toEqual(['a', 'b', 'c']);
  });

  it('converts array element type (not the literal type name)', () => {
    const schema = z.object({ nums: z.array(z.number().min(0)) });
    const nums = zodToJsonSchema(schema).properties.nums as Record<string, unknown>;
    expect(nums.type).toBe('array');
    const items = nums.items as Record<string, unknown>;
    expect(items.type).toBe('number');
    expect(items.minimum).toBe(0);
  });

  it('unwraps defaults and excludes them from required', () => {
    const schema = z.object({
      mode: z.enum(['x', 'y']).default('x'),
      required: z.string(),
    });
    const result = zodToJsonSchema(schema);
    const mode = result.properties.mode as Record<string, unknown>;
    expect(mode.default).toBe('x');
    expect(result.required).toEqual(['required']);
  });

  it('omits required entirely when every field is optional/defaulted', () => {
    const schema = z.object({
      a: z.string().optional(),
      b: z.number().default(1),
    });
    expect(zodToJsonSchema(schema).required).toBeUndefined();
  });
});
