/**
 * Generic tool registry for managing available tools
 *
 * Provides tool lookup by name, tag-based search, dynamic registration,
 * and registry statistics.
 */

import { Tool, ToolHandler } from './tool-types.js';
import { logger } from './logger.js';

/**
 * Registry statistics
 */
export interface RegistryStats {
  totalTools: number;
  toolNames: string[];
  toolVersions: { name: string; version?: string }[];
  allTags: string[];
  defaultTool: string;
}

/**
 * Generic tool registry class
 *
 * Each tool Lambda creates an instance with its own set of tools
 * and a default fallback tool.
 */
export class ToolRegistry {
  private readonly registry = new Map<string, Tool>();
  private readonly defaultTool: Tool;

  /**
   * @param tools - Initial set of tools to register
   * @param defaultTool - Fallback tool when name is not provided or not found
   */
  constructor(tools: Tool[], defaultTool: Tool) {
    this.defaultTool = defaultTool;

    for (const tool of tools) {
      this.registry.set(tool.name, tool);
    }

    logger.info('TOOL_REGISTRY', {
      action: 'registry_initialized',
      ...this.getStats(),
    });
  }

  /**
   * Get a tool handler by name
   *
   * Falls back to the default tool when name is null or not found.
   *
   * @param toolName - Tool name (null falls back to default)
   * @returns Tool handler function
   */
  getHandler(toolName: string | null): ToolHandler {
    if (!toolName) {
      logger.info('TOOL_REGISTRY', {
        action: 'get_default_tool',
        defaultTool: this.defaultTool.name,
        reason: 'no_tool_name_provided',
      });
      return this.defaultTool.handler;
    }

    const tool = this.registry.get(toolName);

    if (!tool) {
      logger.warn('TOOL_REGISTRY', {
        action: 'tool_not_found',
        requestedTool: toolName,
        availableTools: this.getNames(),
        fallbackTool: this.defaultTool.name,
      });
      return this.defaultTool.handler;
    }

    logger.info('TOOL_REGISTRY', {
      action: 'tool_found',
      toolName: tool.name,
      toolVersion: tool.version,
    });

    return tool.handler;
  }

  /**
   * Get a tool definition by name
   *
   * @param toolName - Tool name
   * @returns Tool definition, or undefined if not found
   */
  get(toolName: string): Tool | undefined {
    return this.registry.get(toolName);
  }

  /**
   * Check if a tool exists in the registry
   *
   * @param toolName - Tool name
   * @returns true if registered
   */
  has(toolName: string): boolean {
    return this.registry.has(toolName);
  }

  /**
   * Get all registered tool names
   *
   * @returns Array of tool names
   */
  getNames(): string[] {
    return Array.from(this.registry.keys());
  }

  /**
   * Get all registered tool definitions
   *
   * @returns Array of tool definitions
   */
  getAll(): Tool[] {
    return Array.from(this.registry.values());
  }

  /**
   * Find tools by tag
   *
   * @param tag - Tag to search for
   * @returns Array of matching tools
   */
  getByTag(tag: string): Tool[] {
    return Array.from(this.registry.values()).filter(
      (tool) => tool.tags && tool.tags.includes(tag)
    );
  }

  /**
   * Dynamically register a new tool
   *
   * @param tool - Tool definition
   * @throws Error if tool name is already registered
   */
  register(tool: Tool): void {
    if (this.registry.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }

    this.registry.set(tool.name, tool);

    logger.info('TOOL_REGISTRY', {
      action: 'tool_registered',
      toolName: tool.name,
      toolVersion: tool.version,
      totalTools: this.registry.size,
    });
  }

  /**
   * Remove a tool from the registry
   *
   * @param toolName - Tool name to remove
   * @returns true if removed, false if not found
   */
  unregister(toolName: string): boolean {
    const deleted = this.registry.delete(toolName);

    if (deleted) {
      logger.info('TOOL_REGISTRY', {
        action: 'tool_unregistered',
        toolName,
        totalTools: this.registry.size,
      });
    }

    return deleted;
  }

  /**
   * Get registry statistics
   *
   * @returns Registry stats
   */
  getStats(): RegistryStats {
    const tools = Array.from(this.registry.values());

    return {
      totalTools: tools.length,
      toolNames: tools.map((t) => t.name),
      toolVersions: tools.map((t) => ({ name: t.name, version: t.version })),
      allTags: [...new Set(tools.flatMap((t) => t.tags || []))],
      defaultTool: this.defaultTool.name,
    };
  }

  /**
   * Get the default tool name
   */
  getDefaultToolName(): string {
    return this.defaultTool.name;
  }
}
