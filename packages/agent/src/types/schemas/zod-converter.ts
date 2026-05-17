import { z } from 'zod';
import { JSONSchema, JSONSchemaProperty } from './types.js';

/**
 * Sanitize property key names (to comply with Bedrock constraints)
 * Pattern: ^[a-zA-Z0-9_.-]{1,64}$
 */
export function sanitizePropertyKey(key: string): string {
  // Replace disallowed characters with underscores
  let sanitized = key.replace(/[^a-zA-Z0-9_.-]/g, '_');

  // Truncate to 64 characters
  if (sanitized.length > 64) {
    sanitized = sanitized.substring(0, 64);
  }

  // Use default name if empty
  if (sanitized.length === 0) {
    sanitized = '_param';
  }

  return sanitized;
}

/**
 * Convert JSON Schema to Zod Schema and return key mapping
 */
export function convertToZodSchema(jsonSchema: JSONSchema): {
  schema: z.ZodObject<Record<string, z.ZodTypeAny>>;
  keyMapping: Record<string, string>; // sanitizedKey -> originalKey
} {
  if (!jsonSchema || jsonSchema.type !== 'object') {
    return { schema: z.object({}), keyMapping: {} };
  }

  const properties = jsonSchema.properties || {};
  const required = jsonSchema.required || [];
  const zodFields: Record<string, z.ZodTypeAny> = {};
  const keyMapping: Record<string, string> = {};

  for (const [key, prop] of Object.entries(properties)) {
    const propSchema = prop as JSONSchemaProperty;

    // Sanitize property key name
    const sanitizedKey = sanitizePropertyKey(key);
    keyMapping[sanitizedKey] = key; // Record mapping

    let zodType: z.ZodTypeAny;

    switch (propSchema.type) {
      case 'string':
        zodType = z.string();
        break;
      case 'number':
      case 'integer':
        zodType = z.number();
        break;
      case 'boolean':
        zodType = z.boolean();
        break;
      case 'array':
        zodType = z.array(z.unknown());
        break;
      case 'object':
        zodType = z.record(z.string(), z.unknown());
        break;
      default:
        zodType = z.unknown();
    }

    if (propSchema.description) {
      zodType = zodType.describe(propSchema.description);
    }

    if (!required.includes(key)) {
      zodType = zodType.optional();
    }

    zodFields[sanitizedKey] = zodType;
  }

  return { schema: z.object(zodFields), keyMapping };
}
