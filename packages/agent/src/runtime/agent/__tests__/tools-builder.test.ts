/**
 * Tools Builder Unit Tests
 *
 * Tests for selectEnabledTools() and buildToolSet()
 * which integrate local tools, Gateway MCP tools, and user-defined MCP clients.
 *
 * Uses jest.unstable_mockModule + dynamic import for ESM compatibility.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Mock definitions ───────────────────────────────────────────────────

const mockLocalTools = [
  { name: 'tool_a', description: 'Tool A' },
  { name: 'tool_b', description: 'Tool B' },
  { name: 'tool_c', description: 'Tool C' },
];

const mockGatewayMCPTools = [
  { name: 'gateway_tool_1', description: 'Gateway Tool 1' },
  { name: 'gateway_tool_2', description: 'Gateway Tool 2' },
];

const mockGatewayStrandsTools = [
  { name: 'gateway_tool_1', description: 'Gateway Tool 1 (Strands)' },
  { name: 'gateway_tool_2', description: 'Gateway Tool 2 (Strands)' },
];

const mockListTools = jest.fn<() => Promise<unknown[]>>().mockResolvedValue(mockGatewayMCPTools);

// ── Register ESM mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../config/index.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  config: {},
}));

jest.unstable_mockModule('../../tools/index.js', () => ({
  localTools: mockLocalTools,
  convertMCPToolsToStrands: () => mockGatewayStrandsTools,
}));

jest.unstable_mockModule('../../../libs/mcp/client.js', () => ({
  mcpClient: {
    listTools: mockListTools,
  },
}));

// ── Dynamic imports ────────────────────────────────────────────────────

const { selectEnabledTools, buildToolSet } = await import('../tools-builder.js');

describe('selectEnabledTools', () => {
  const tools = [
    { name: 'alpha', desc: 'A' },
    { name: 'beta', desc: 'B' },
    { name: 'gamma', desc: 'C' },
  ];

  it('should return empty array when enabledTools is undefined', () => {
    const result = selectEnabledTools(tools, undefined);
    expect(result).toEqual([]);
  });

  it('should return empty array when enabledTools is empty array', () => {
    const result = selectEnabledTools(tools, []);
    expect(result).toEqual([]);
  });

  it('should filter tools by name when enabledTools is specified', () => {
    const result = selectEnabledTools(tools, ['alpha', 'gamma']);
    expect(result).toEqual([
      { name: 'alpha', desc: 'A' },
      { name: 'gamma', desc: 'C' },
    ]);
  });

  it('should return empty array when no tools match', () => {
    const result = selectEnabledTools(tools, ['nonexistent']);
    expect(result).toEqual([]);
  });

  it('should handle single tool filter', () => {
    const result = selectEnabledTools(tools, ['beta']);
    expect(result).toEqual([{ name: 'beta', desc: 'B' }]);
  });

  it('should ignore unknown tool names in filter', () => {
    const result = selectEnabledTools(tools, ['alpha', 'unknown', 'gamma']);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.name)).toEqual(['alpha', 'gamma']);
  });
});

describe('buildToolSet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListTools.mockResolvedValue(mockGatewayMCPTools);
  });

  it('should return empty tools when enabledTools is undefined', async () => {
    const result = await buildToolSet(undefined, []);

    expect(result.tools).toEqual([]);
    expect(result.mcpClients).toEqual([]);
    expect(result.counts.total).toBe(0);
  });

  it('should return empty tools when enabledTools is empty array', async () => {
    const result = await buildToolSet([], []);

    expect(result.tools).toEqual([]);
    expect(result.counts.total).toBe(0);
  });

  it('should filter tools from combined local + gateway tools', async () => {
    const result = await buildToolSet(['tool_a', 'gateway_tool_1'], []);

    expect(result.tools).toHaveLength(2);
    expect(result.tools.map((t) => t.name)).toEqual(['tool_a', 'gateway_tool_1']);
  });

  it('should include userMCPClients as-is (not filtered)', async () => {
    const mockUserClients = [{ id: 'user-mcp-1' }, { id: 'user-mcp-2' }] as unknown[];

    const result = await buildToolSet(['tool_a'], mockUserClients as never[]);

    expect(result.mcpClients).toEqual(mockUserClients);
    expect(result.counts.userMCP).toBe(2);
  });

  it('should report correct counts', async () => {
    const result = await buildToolSet(['tool_a', 'tool_b', 'gateway_tool_1'], []);

    expect(result.counts.local).toBe(3); // All local tools available
    expect(result.counts.gateway).toBe(2); // All gateway tools available
    expect(result.counts.userMCP).toBe(0);
    expect(result.counts.total).toBe(3); // 3 filtered tools + 0 user MCP
  });

  it('should fetch gateway tools via mcpClient.listTools', async () => {
    await buildToolSet(undefined, []);

    expect(mockListTools).toHaveBeenCalledTimes(1);
  });

  it('should include gatewayMCPTools in result for prompt generation', async () => {
    const result = await buildToolSet(undefined, []);

    expect(result.gatewayMCPTools).toEqual(mockGatewayMCPTools);
  });

  it('should use default empty array for userMCPClients', async () => {
    const result = await buildToolSet(undefined);

    expect(result.mcpClients).toEqual([]);
    expect(result.counts.userMCP).toBe(0);
  });

  it('should propagate errors when mcpClient.listTools fails', async () => {
    mockListTools.mockRejectedValue(new Error('Gateway unavailable'));

    await expect(buildToolSet([], [])).rejects.toThrow('Gateway unavailable');
  });
});
