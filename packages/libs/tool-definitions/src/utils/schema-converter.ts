import { z } from 'zod';

/**
 * Convert Zod schema to JSON Schema
 *
 * Note: Complete conversion is complex, so this implementation is limited to Zod features used in the project
 */
export function zodToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
} {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodType = value as z.ZodTypeAny;
    properties[key] = convertZodType(zodType);

    // Check if field is optional
    if (!isOptional(zodType)) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function convertZodType(zodType: z.ZodTypeAny): Record<string, unknown> {
  // Unwrap ZodOptional / ZodDefault
  let innerType = zodType;
  const description = zodType.description;
  let defaultValue: unknown;

  if (zodType instanceof z.ZodOptional) {
    innerType = zodType.unwrap() as z.ZodTypeAny;
  }
  if (zodType instanceof z.ZodDefault) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defValue = (zodType._def as any).defaultValue;
    defaultValue = typeof defValue === 'function' ? defValue() : defValue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    innerType = (zodType._def as any).innerType;
  }

  const result: Record<string, unknown> = {};

  // Type conversion
  //
  // NOTE: Zod 4 reshaped the internal `_def` layout compared with Zod 3:
  //   - string/number constraints live in `_def.checks[i]._zod.def`
  //     (`{ check: 'min_length' | 'greater_than' | ..., minimum/maximum/value }`)
  //     instead of `_def.checks[i].{ kind, value }`.
  //   - enum members are exposed via the public `.options` array (the old
  //     `_def.values` array no longer exists; `_def.entries` is an object map).
  //   - array element schema is `_def.element` (the old `_def.type` now holds
  //     the type-name string `'array'`).
  // We read the Zod 4 shapes here, falling back to the Zod 3 shapes so the
  // converter stays robust if the dependency is ever pinned back.
  if (innerType instanceof z.ZodString) {
    result.type = 'string';
    for (const def of getCheckDefs(innerType)) {
      if (def.check === 'min_length' && typeof def.minimum === 'number')
        result.minLength = def.minimum;
      if (def.check === 'max_length' && typeof def.maximum === 'number')
        result.maxLength = def.maximum;
      // Zod 3 fallback
      if (def.kind === 'min') result.minLength = def.value;
      if (def.kind === 'max') result.maxLength = def.value;
    }
  } else if (innerType instanceof z.ZodNumber) {
    result.type = 'number';
    for (const def of getCheckDefs(innerType)) {
      if (def.check === 'greater_than' && typeof def.value === 'number')
        result.minimum = def.value;
      if (def.check === 'less_than' && typeof def.value === 'number') result.maximum = def.value;
      // Zod 3 fallback
      if (def.kind === 'min') result.minimum = def.value;
      if (def.kind === 'max') result.maximum = def.value;
    }
  } else if (innerType instanceof z.ZodBoolean) {
    result.type = 'boolean';
  } else if (innerType instanceof z.ZodEnum) {
    result.type = 'string';
    // Zod 4 exposes members via `.options`; fall back to the Zod 3 `_def.values`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options = (innerType as any).options ?? (innerType._def as any).values;
    result.enum = options;
  } else if (innerType instanceof z.ZodArray) {
    result.type = 'array';
    // Zod 4: element schema is `_def.element`; Zod 3: `_def.type`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const element = (innerType._def as any).element ?? (innerType._def as any).type;
    result.items = convertZodType(element as z.ZodTypeAny);
  } else if (innerType instanceof z.ZodObject) {
    const nested = zodToJsonSchema(innerType);
    result.type = 'object';
    result.properties = nested.properties;
    if (nested.required) result.required = nested.required;
  } else if (innerType instanceof z.ZodUnion) {
    // Handle union types (oneOf)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options = (innerType._def as any).options as z.ZodTypeAny[];
    result.oneOf = options.map((opt) => convertZodType(opt));
  } else {
    result.type = 'string'; // Fallback
  }

  if (description) result.description = description;
  if (defaultValue !== undefined) result.default = defaultValue;

  return result;
}

function isOptional(zodType: z.ZodTypeAny): boolean {
  return zodType instanceof z.ZodOptional || zodType.isOptional();
}

/**
 * Normalised view of a Zod constraint "check".
 *
 * Zod 4 stores each check as `{ _zod: { def: { check, value, minimum, maximum, ... } } }`,
 * whereas Zod 3 stored `{ kind, value }` directly on the check object. This helper
 * returns the underlying def regardless of version so the type converters above
 * can read `check`/`kind`/`value`/`minimum`/`maximum` uniformly.
 */
interface CheckDef {
  check?: string;
  kind?: string;
  value?: number;
  minimum?: number;
  maximum?: number;
}

function getCheckDefs(zodType: z.ZodTypeAny): CheckDef[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const checks = ((zodType._def as any).checks || []) as any[];
  return checks.map((check) => {
    // Zod 4: the meaningful fields live under `_zod.def`. Zod 3: on the check itself.
    const def = check?._zod?.def ?? check?.def ?? check;
    return def as CheckDef;
  });
}
