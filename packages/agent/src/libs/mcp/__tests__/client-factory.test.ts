/**
 * MCP client factory — resilience against a rate-limited remote server (GH #386).
 *
 * Runs a real local HTTP server that speaks just enough legacy Streamable HTTP MCP
 * so the actual Strands McpClient + @modelcontextprotocol/client stack is exercised.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMCPClients, clearMCPClientCache } from '../client-factory.js';

type Mode = 'probe-429' | 'all-429' | 'ok';

let mode: Mode = 'ok';
let server: Server;
let url: string;
const receivedHeaders: Array<Record<string, string | string[] | undefined>> = [];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function tooManyRequests(res: ServerResponse, id: unknown): void {
  sendJson(res, 429, { jsonrpc: '2.0', id, error: { code: -32000, message: 'Too many requests' } });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  receivedHeaders.push(req.headers);
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const msg = JSON.parse(raw) as { id?: unknown; method: string };

  if (mode === 'all-429' || (mode === 'probe-429' && msg.method === 'server/discover')) {
    tooManyRequests(res, msg.id);
    return;
  }
  if (msg.id === undefined) {
    res.writeHead(202).end();
    return;
  }
  switch (msg.method) {
    case 'initialize':
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake', version: '1.0.0' },
        },
      });
      return;
    case 'tools/list':
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] },
      });
      return;
    default:
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found' },
      });
  }
}

beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  clearMCPClientCache();
  receivedHeaders.length = 0;
  mode = 'ok';
});

const servers = () => [
  {
    name: 'knowledge',
    config: { transport: 'http' as const, url, headers: { 'X-Test': 'yes' } },
  },
];

describe('createMCPClients (http)', () => {
  it('falls back to legacy initialize when the server/discover probe gets HTTP 429', async () => {
    mode = 'probe-429';
    const [client] = createMCPClients(servers());

    const tools = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(client.connectionState).toBe('connected');
  });

  it('forwards configured headers', async () => {
    const [client] = createMCPClients(servers());
    await client.listTools();

    expect(receivedHeaders.some((h) => h['x-test'] === 'yes')).toBe(true);
  });

  it('drops the server tools instead of failing the turn when every request is rate-limited', async () => {
    mode = 'all-429';
    const [client] = createMCPClients(servers());

    await expect(client.listTools()).resolves.toEqual([]);
    expect(client.connectionState).toBe('failed');
  });

  it('replaces a cached client that failed to connect on the next turn', async () => {
    mode = 'all-429';
    const [first] = createMCPClients(servers());
    await first.listTools();
    expect(first.connectionState).toBe('failed');

    mode = 'ok';
    const [second] = createMCPClients(servers());

    expect(second).not.toBe(first);
    const tools = await second.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
  });

  it('keeps reusing a healthy cached client', async () => {
    const [first] = createMCPClients(servers());
    await first.listTools();

    const [second] = createMCPClients(servers());

    expect(second).toBe(first);
  });
});
