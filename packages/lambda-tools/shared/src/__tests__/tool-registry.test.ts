import { ToolRegistry } from '../tool-registry.js';
import { Tool, ToolHandler } from '../tool-types.js';

function makeHandler(): ToolHandler {
  return jest.fn().mockResolvedValue({ ok: true });
}

function makeTool(name: string, tags?: string[], version?: string): Tool {
  return {
    name,
    handler: makeHandler(),
    description: `${name} description`,
    version,
    tags,
  };
}

describe('ToolRegistry', () => {
  let echoTool: Tool;
  let pingTool: Tool;
  let defaultTool: Tool;

  beforeEach(() => {
    echoTool = makeTool('echo', ['utility', 'text'], '1.0.0');
    pingTool = makeTool('ping', ['utility', 'network'], '2.0.0');
    defaultTool = makeTool('default', ['utility']);
  });

  describe('constructor', () => {
    it('registers all provided tools', () => {
      const registry = new ToolRegistry([echoTool, pingTool], defaultTool);
      expect(registry.has('echo')).toBe(true);
      expect(registry.has('ping')).toBe(true);
    });

    it('sets the default tool', () => {
      const registry = new ToolRegistry([echoTool], defaultTool);
      expect(registry.getDefaultToolName()).toBe('default');
    });

    it('works with an empty initial tool list', () => {
      const registry = new ToolRegistry([], defaultTool);
      expect(registry.getNames()).toHaveLength(0);
      expect(registry.getDefaultToolName()).toBe('default');
    });
  });

  describe('getHandler', () => {
    it('returns the handler for a known tool', () => {
      const registry = new ToolRegistry([echoTool, pingTool], defaultTool);
      expect(registry.getHandler('echo')).toBe(echoTool.handler);
    });

    it('returns the default handler when name is null', () => {
      const registry = new ToolRegistry([echoTool], defaultTool);
      expect(registry.getHandler(null)).toBe(defaultTool.handler);
    });

    it('returns the default handler when tool name is not found', () => {
      const registry = new ToolRegistry([echoTool], defaultTool);
      expect(registry.getHandler('unknown-tool')).toBe(defaultTool.handler);
    });
  });

  describe('get', () => {
    it('returns the tool definition for a registered tool', () => {
      const registry = new ToolRegistry([echoTool], defaultTool);
      expect(registry.get('echo')).toBe(echoTool);
    });

    it('returns undefined for an unregistered tool', () => {
      const registry = new ToolRegistry([echoTool], defaultTool);
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });

  describe('has', () => {
    it('returns true for a registered tool', () => {
      const registry = new ToolRegistry([echoTool], defaultTool);
      expect(registry.has('echo')).toBe(true);
    });

    it('returns false for an unregistered tool', () => {
      const registry = new ToolRegistry([echoTool], defaultTool);
      expect(registry.has('nonexistent')).toBe(false);
    });
  });

  describe('getNames', () => {
    it('returns all registered tool names', () => {
      const registry = new ToolRegistry([echoTool, pingTool], defaultTool);
      const names = registry.getNames();
      expect(names).toHaveLength(2);
      expect(names).toContain('echo');
      expect(names).toContain('ping');
    });

    it('returns empty array when no tools are registered', () => {
      const registry = new ToolRegistry([], defaultTool);
      expect(registry.getNames()).toEqual([]);
    });
  });

  describe('getAll', () => {
    it('returns all registered tool definitions', () => {
      const registry = new ToolRegistry([echoTool, pingTool], defaultTool);
      const tools = registry.getAll();
      expect(tools).toHaveLength(2);
      expect(tools).toContain(echoTool);
      expect(tools).toContain(pingTool);
    });
  });

  describe('getByTag', () => {
    it('returns tools matching a tag', () => {
      const registry = new ToolRegistry([echoTool, pingTool], defaultTool);
      const result = registry.getByTag('text');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(echoTool);
    });

    it('returns multiple tools when they share a tag', () => {
      const registry = new ToolRegistry([echoTool, pingTool], defaultTool);
      const result = registry.getByTag('utility');
      expect(result).toHaveLength(2);
    });

    it('returns empty array when no tools match the tag', () => {
      const registry = new ToolRegistry([echoTool, pingTool], defaultTool);
      expect(registry.getByTag('nonexistent-tag')).toEqual([]);
    });

    it('returns empty array for tools without tags', () => {
      const noTagTool = makeTool('no-tag');
      const registry = new ToolRegistry([noTagTool], defaultTool);
      expect(registry.getByTag('utility')).toEqual([]);
    });
  });

  describe('register', () => {
    it('adds a new tool to the registry', () => {
      const registry = new ToolRegistry([], defaultTool);
      registry.register(echoTool);
      expect(registry.has('echo')).toBe(true);
      expect(registry.get('echo')).toBe(echoTool);
    });

    it('throws an Error when registering a duplicate tool name', () => {
      const registry = new ToolRegistry([echoTool], defaultTool);
      const duplicate = makeTool('echo');
      expect(() => registry.register(duplicate)).toThrow(Error);
      expect(() => registry.register(duplicate)).toThrow("Tool 'echo' is already registered");
    });
  });

  describe('unregister', () => {
    it('removes a registered tool and returns true', () => {
      const registry = new ToolRegistry([echoTool], defaultTool);
      expect(registry.unregister('echo')).toBe(true);
      expect(registry.has('echo')).toBe(false);
    });

    it('returns false when the tool is not found', () => {
      const registry = new ToolRegistry([], defaultTool);
      expect(registry.unregister('nonexistent')).toBe(false);
    });
  });

  describe('getStats', () => {
    it('returns correct statistics', () => {
      const registry = new ToolRegistry([echoTool, pingTool], defaultTool);
      const stats = registry.getStats();

      expect(stats.totalTools).toBe(2);
      expect(stats.toolNames).toContain('echo');
      expect(stats.toolNames).toContain('ping');
      expect(stats.defaultTool).toBe('default');
      expect(stats.allTags).toContain('utility');
      expect(stats.allTags).toContain('text');
      expect(stats.allTags).toContain('network');
    });

    it('deduplicates tags in allTags', () => {
      const registry = new ToolRegistry([echoTool, pingTool], defaultTool);
      const stats = registry.getStats();
      const utilityCounts = stats.allTags.filter((t) => t === 'utility').length;
      expect(utilityCounts).toBe(1);
    });

    it('includes tool versions in toolVersions', () => {
      const registry = new ToolRegistry([echoTool, pingTool], defaultTool);
      const stats = registry.getStats();
      expect(stats.toolVersions).toContainEqual({ name: 'echo', version: '1.0.0' });
      expect(stats.toolVersions).toContainEqual({ name: 'ping', version: '2.0.0' });
    });

    it('returns zero totalTools for empty registry', () => {
      const registry = new ToolRegistry([], defaultTool);
      const stats = registry.getStats();
      expect(stats.totalTools).toBe(0);
      expect(stats.toolNames).toEqual([]);
      expect(stats.allTags).toEqual([]);
    });
  });

  describe('getDefaultToolName', () => {
    it('returns the name of the default tool', () => {
      const registry = new ToolRegistry([echoTool], defaultTool);
      expect(registry.getDefaultToolName()).toBe('default');
    });
  });
});
