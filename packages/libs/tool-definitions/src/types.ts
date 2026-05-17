import { z } from 'zod';

/**
 * JSON Schema format tool definition (for MCP/Backend)
 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Tool definition supporting both Zod and JSON Schema
 */
export interface ToolDefinition<T extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string;
  zodSchema: T;
  jsonSchema: MCPToolDefinition['inputSchema'];
}
