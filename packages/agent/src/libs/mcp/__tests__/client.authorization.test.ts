/**
 * AgentCoreMCPClient: Gateway 3LO (URL elicitation) handling.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../config/index.js', () => ({
  config: { AGENTCORE_GATEWAY_ENDPOINT: 'https://gw.example/mcp', AWS_REGION: 'us-west-2' },
}));

const { AgentCoreMCPClient } = await import('../client.js');
const { createRequestContext, runWithContext } = await import('../../context/request-context.js');

const AUTH_URL =
  'https://bedrock-agentcore.us-west-2.amazonaws.com/identities/oauth2/authorize?request_uri=x';

function mockFetchJson(body: unknown) {
  const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  } as Response);
  global.fetch = fetchMock;
  return fetchMock;
}

function callTool(name: string) {
  const client = new AgentCoreMCPClient();
  return runWithContext(createRequestContext('Bearer user-token'), () => client.callTool(name, {}));
}

describe('AgentCoreMCPClient.callTool', () => {
  beforeEach(() => jest.restoreAllMocks());

  it('sends the MCP protocol version required for URL elicitation', async () => {
    const fetchMock = mockFetchJson({ jsonrpc: '2.0', id: 1, result: { content: [] } });
    await callTool('github___get_me');
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['MCP-Protocol-Version']).toBe('2025-11-25');
  });

  it('returns the authorization request for -32042 instead of an error text', async () => {
    mockFetchJson({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32042,
        message: 'This request requires more information.',
        data: { elicitations: [{ mode: 'url', elicitationId: 'e-1', url: AUTH_URL }] },
      },
    });
    const result = await callTool('github___get_me');
    expect(result.authorization).toEqual({
      url: AUTH_URL,
      elicitationId: 'e-1',
      targetName: 'github',
    });
    expect(result.content).toEqual([]);
  });

  it('keeps other JSON-RPC errors as tool errors', async () => {
    mockFetchJson({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Unknown tool' } });
    const result = await callTool('github___nope');
    expect(result.authorization).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });
});
