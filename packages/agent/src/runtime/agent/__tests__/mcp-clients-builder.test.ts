/**
 * MCP Clients Builder Unit Tests
 *
 * Tests for buildUserMCPClients() which builds MCP clients
 * from user-provided mcp.json configuration.
 *
 * Uses jest.unstable_mockModule + dynamic import for ESM compatibility.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Mock definitions ───────────────────────────────────────────────────

const mockGetEnabledMCPServers = jest.fn<any>().mockReturnValue([]);
const mockCreateMCPClients = jest.fn<any>().mockReturnValue([]);

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

jest.unstable_mockModule('../../../libs/mcp/index.js', () => ({
  getEnabledMCPServers: mockGetEnabledMCPServers,
  createMCPClients: mockCreateMCPClients,
}));

// ── Dynamic imports ────────────────────────────────────────────────────

const { buildUserMCPClients } = await import('../mcp-clients-builder.js');

describe('buildUserMCPClients', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEnabledMCPServers.mockReturnValue([]);
    mockCreateMCPClients.mockReturnValue([]);
  });

  it('should return empty array when mcpConfig is undefined', () => {
    const result = buildUserMCPClients(undefined);

    expect(result).toEqual([]);
    expect(mockGetEnabledMCPServers).not.toHaveBeenCalled();
    expect(mockCreateMCPClients).not.toHaveBeenCalled();
  });

  it('should process MCP config and return clients', () => {
    const mockServers = [{ name: 'server1' }, { name: 'server2' }];
    const mockClients = [{ id: 'client1' }, { id: 'client2' }];

    mockGetEnabledMCPServers.mockReturnValue(mockServers);
    mockCreateMCPClients.mockReturnValue(mockClients);

    const mcpConfig = {
      mcpServers: {
        server1: { command: 'npx', args: ['-y', 'server1'] },
        server2: { command: 'npx', args: ['-y', 'server2'] },
      },
    };

    const result = buildUserMCPClients(mcpConfig);

    expect(mockGetEnabledMCPServers).toHaveBeenCalledWith(mcpConfig);
    expect(mockCreateMCPClients).toHaveBeenCalledWith(mockServers);
    expect(result).toEqual(mockClients);
  });

  it('should return empty array when getEnabledMCPServers throws', () => {
    mockGetEnabledMCPServers.mockImplementation(() => {
      throw new Error('Invalid MCP config');
    });

    const result = buildUserMCPClients({ invalid: true });

    expect(result).toEqual([]);
  });

  it('should return empty array when createMCPClients throws', () => {
    mockGetEnabledMCPServers.mockReturnValue([{ name: 'server1' }]);
    mockCreateMCPClients.mockImplementation(() => {
      throw new Error('Failed to create client');
    });

    const result = buildUserMCPClients({ mcpServers: {} });

    expect(result).toEqual([]);
  });

  it('should return empty array when no servers are found', () => {
    mockGetEnabledMCPServers.mockReturnValue([]);
    mockCreateMCPClients.mockReturnValue([]);

    const result = buildUserMCPClients({ mcpServers: {} });

    expect(result).toEqual([]);
    expect(mockCreateMCPClients).toHaveBeenCalledWith([]);
  });

  it('should handle empty mcpConfig object', () => {
    mockGetEnabledMCPServers.mockReturnValue([]);
    mockCreateMCPClients.mockReturnValue([]);

    const result = buildUserMCPClients({});

    expect(result).toEqual([]);
    expect(mockGetEnabledMCPServers).toHaveBeenCalledWith({});
  });
});
