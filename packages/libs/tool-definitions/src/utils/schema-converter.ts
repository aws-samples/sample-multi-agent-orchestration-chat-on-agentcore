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
  if (innerType instanceof z.ZodString) {
    result.type = 'string';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const checks = (innerType._def as any).checks || [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const check of checks as any[]) {
      if (check.kind === 'min') result.minLength = check.value;
      if (check.kind === 'max') result.maxLength = check.value;
    }
  } else if (innerType instanceof z.ZodNumber) {
    result.type = 'number';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const checks = (innerType._def as any).checks || [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const check of checks as any[]) {
      if (check.kind === 'min') result.minimum = check.value;
      if (check.kind === 'max') result.maximum = check.value;
    }
  } else if (innerType instanceof z.ZodBoolean) {
    result.type = 'boolean';
  } else if (innerType instanceof z.ZodEnum) {
    result.type = 'string';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result.enum = (innerType._def as any).values;
  } else if (innerType instanceof z.ZodArray) {
    result.type = 'array';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result.items = convertZodType((innerType._def as any).type);
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
