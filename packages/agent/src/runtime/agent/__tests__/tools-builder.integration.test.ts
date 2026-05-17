/**
 * Tools Builder Integration Tests
 *
 * Tests buildToolSet() with actual AgentCore Gateway endpoint.
 * Conditionally skipped when AGENTCORE_GATEWAY_ENDPOINT is not configured.
 *
 * Required env vars:
 * - AGENTCORE_GATEWAY_ENDPOINT: Gateway endpoint for tool listing
 *
 * Run: cd packages/agent && npm run test:integration -- tools-builder.integration
 */

import { it, expect } from '@jest/globals';
import { describeIfEnv } from '../../tests/integration-helpers.js';
import { buildToolSet, selectEnabledTools } from '../tools-builder.js';

const describeWithGateway = describeIfEnv(
  ['AGENTCORE_GATEWAY_ENDPOINT'],
  'Tools builder integration'
);

describeWithGateway('buildToolSet integration', () => {
  it('should fetch tools from Gateway and build tool set', async () => {
    const result = await buildToolSet([], []);

    expect(result).toBeDefined();
    expect(result.tools).toBeInstanceOf(Array);
    expect(result.mcpClients).toBeInstanceOf(Array);
    expect(result.gatewayMCPTools).toBeInstanceOf(Array);
    expect(result.counts).toBeDefined();
    expect(typeof result.counts.local).toBe('number');
    expect(typeof result.counts.gateway).toBe('number');
    expect(typeof result.counts.total).toBe('number');
  });

  it('should return empty tools when enabledTools is undefined', async () => {
    const result = await buildToolSet(undefined, []);

    expect(result.tools).toEqual([]);
    expect(result.counts.total).toBe(0);
  });

  it('should return empty tools when enabledTools is empty array', async () => {
    const result = await buildToolSet([], []);

    expect(result.tools).toEqual([]);
    expect(result.counts.total).toBe(0);
  });

  it('should filter tools when specific names are provided', async () => {
    // Use 'think' as it is a known local tool
    const result = await buildToolSet(['think'], []);

    expect(result.tools.length).toBeLessThanOrEqual(1);
    if (result.tools.length > 0) {
      expect(result.tools[0].name).toBe('think');
    }
  });

  it('should report gateway tool count in counts', async () => {
    const result = await buildToolSet([], []);

    // Gateway tools should be fetched even if not in the filtered result
    expect(result.counts.gateway).toBeGreaterThanOrEqual(0);
    expect(result.gatewayMCPTools.length).toBe(result.counts.gateway);
  });

  it('should include local tools count', async () => {
    const result = await buildToolSet([], []);

    expect(result.counts.local).toBeGreaterThan(0);
  });
});

describeWithGateway('selectEnabledTools integration', () => {
  it('should work with real tool objects', async () => {
    // Build the full tool set first
    const fullResult = await buildToolSet(['think'], []);

    // selectEnabledTools should handle the real tool shapes
    const filtered = selectEnabledTools(fullResult.tools, ['think']);
    expect(filtered.every((t) => t.name === 'think')).toBe(true);
  });
});
