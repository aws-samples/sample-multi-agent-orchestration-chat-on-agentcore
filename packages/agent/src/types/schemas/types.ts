/**
 * Type definition for JSON Schema properties
 */
export interface JSONSchemaProperty {
  type: string;
  description?: string;
}

/**
 * Type definition for JSON Schema
 */
export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
}

/**
 * Type definition for MCP tool
 */
export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema: JSONSchema;
}

/**
 * Type definition for tool input
 */
export type ToolInput = Record<string, unknown>;
