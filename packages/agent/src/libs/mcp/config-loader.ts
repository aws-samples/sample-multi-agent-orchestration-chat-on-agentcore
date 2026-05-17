/**
 * MCP configuration processing utility
 */

import { logger } from '../logger/index.js';
import type { MCPConfig, MCPServerConfig } from './types.js';
import { MCPConfigError } from './types.js';

/**
 * Private/internal IP ranges that must not be accessed via MCP HTTP/SSE transport.
 * Blocks SSRF attacks targeting internal networks and cloud metadata endpoints.
 * Note: DNS rebinding cannot be fully prevented at the application layer;
 * network-level controls (VPC security groups / NACLs) are required as the primary defence.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal', // GCP metadata
]);

const PRIVATE_IPV4_RANGES: Array<{ prefix: number[]; bits: number }> = [
  { prefix: [127], bits: 8 }, // loopback
  { prefix: [10], bits: 8 }, // RFC-1918
  { prefix: [172, 16], bits: 12 }, // RFC-1918
  { prefix: [192, 168], bits: 16 }, // RFC-1918
  { prefix: [169, 254], bits: 16 }, // link-local / AWS IMDS
  { prefix: [100, 64], bits: 10 }, // Shared Address Space (RFC-6598)
  { prefix: [0], bits: 8 }, // "This" network
];

function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const addr = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  for (const { prefix, bits } of PRIVATE_IPV4_RANGES) {
    let mask = 0;
    for (let i = 0; i < prefix.length; i++) {
      mask = (mask << 8) | prefix[i];
    }
    mask = mask << (32 - bits);
    const maskBits = ~0 << (32 - bits);
    if ((addr & maskBits) === mask) {
      return true;
    }
  }
  return false;
}

function isPrivateIPv6(hostname: string): boolean {
  // Strip surrounding brackets if present (e.g., [::1])
  const h = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const lower = h.toLowerCase();
  return (
    lower === '::1' || // loopback
    lower.startsWith('fc') || // Unique Local (fc00::/7)
    lower.startsWith('fd') ||
    lower.startsWith('fe80') || // link-local (fe80::/10)
    lower.startsWith('::ffff:') // IPv4-mapped
  );
}

/**
 * Validate a URL for use with HTTP/SSE MCP transports.
 * Throws MCPConfigError if the URL targets private/internal addresses (SSRF prevention).
 */
function validateUrl(serverName: string, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MCPConfigError(`Invalid URL for MCP server "${serverName}": ${url}`);
  }

  // Require HTTPS only
  if (parsed.protocol !== 'https:') {
    throw new MCPConfigError(
      `MCP server "${serverName}" must use HTTPS (got "${parsed.protocol}"). Plain HTTP is not allowed.`
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new MCPConfigError(
      `MCP server "${serverName}" targets a blocked hostname "${hostname}". Internal/local addresses are not allowed.`
    );
  }

  if (isPrivateIPv4(hostname)) {
    throw new MCPConfigError(
      `MCP server "${serverName}" targets a private IPv4 address "${hostname}". Internal network access is not allowed.`
    );
  }

  if (isPrivateIPv6(hostname)) {
    throw new MCPConfigError(
      `MCP server "${serverName}" targets a private IPv6 address "${hostname}". Internal network access is not allowed.`
    );
  }
}

/**
 * Auto-infer and add transport field to MCP server configuration
 * - stdio if command exists
 * - http if url exists (default)
 */
function inferTransport(serverConfig: Record<string, unknown>): Record<string, unknown> {
  // Return as-is if transport already specified
  if (serverConfig.transport) {
    return serverConfig;
  }

  // stdio if command exists
  if (serverConfig.command) {
    logger.debug('Auto-inferring transport: stdio (command field exists)');
    return { ...serverConfig, transport: 'stdio' };
  }

  // http if url exists (default, SSE detection can be added in future)
  if (serverConfig.url) {
    logger.debug('Auto-inferring transport: http (url field exists)');
    return { ...serverConfig, transport: 'http' };
  }

  // Return as-is if neither exists (will error in Zod validation)
  return serverConfig;
}

/**
 * Extract only enabled MCP server configurations
 * Apply auto-inference if transport is not specified
 * Security check:
 *   - HTTP/SSE URLs must not target private/internal addresses (SSRF prevention)
 *   - stdio is allowed on AgentCore Runtime (user-scoped permissions)
 */
export function getEnabledMCPServers(config: MCPConfig): Array<{
  name: string;
  config: MCPServerConfig;
}> {
  const servers = Object.entries(config.mcpServers)
    .filter(([, serverConfig]) => serverConfig.enabled !== false)
    .map(([name, serverConfig]) => ({
      name,
      config: inferTransport(
        serverConfig as unknown as Record<string, unknown>
      ) as unknown as MCPServerConfig,
    }));

  for (const { name, config: serverConfig } of servers) {
    // SSRF prevention: validate URLs for HTTP/SSE transports
    // stdio is intentionally allowed on AgentCore Runtime (user-scoped IAM permissions)
    if (serverConfig.transport === 'http' || serverConfig.transport === 'sse') {
      validateUrl(name, serverConfig.url);
    }
  }

  return servers;
}
