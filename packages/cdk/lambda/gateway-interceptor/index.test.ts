import { handler, isMachineUserPayload, isUserDelegatedTool } from './index';

function jwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`;
}

const USER = { sub: 'user-uuid', client_id: 'web-client', username: 'alice', token_use: 'access' };
const MACHINE = { sub: 'machine-client', client_id: 'machine-client', token_use: 'access' };

function toolsCall(name: string, payload: Record<string, unknown>) {
  return {
    mcp: {
      gatewayRequest: {
        headers: { Authorization: `Bearer ${jwt(payload)}` },
        body: {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name, arguments: { q: 1 } },
        },
      },
    },
  };
}

describe('gateway interceptor: user-delegated (3LO) targets', () => {
  const original = process.env.USER_DELEGATED_TARGETS;
  beforeEach(() => {
    process.env.USER_DELEGATED_TARGETS = 'github';
  });
  afterAll(() => {
    process.env.USER_DELEGATED_TARGETS = original;
  });

  it('matches only the `{target}___` prefix', () => {
    expect(isUserDelegatedTool('github___get_me', ['github'])).toBe(true);
    expect(isUserDelegatedTool('github-tools___x', ['github'])).toBe(false);
    expect(isUserDelegatedTool('utility-tools___echo', ['github'])).toBe(false);
    expect(isUserDelegatedTool(undefined, ['github'])).toBe(false);
  });

  it('classifies Client Credentials tokens as machine users', () => {
    expect(isMachineUserPayload(MACHINE)).toBe(true);
    expect(isMachineUserPayload(USER)).toBe(false);
  });

  it('forwards user calls without injecting _context', async () => {
    const out = await handler(toolsCall('github___get_me', USER));
    expect(out.mcp.transformedGatewayResponse).toBeUndefined();
    expect(out.mcp.transformedGatewayRequest?.body.params.arguments).toEqual({ q: 1 });
  });

  it('short-circuits machine-user calls with a tool error', async () => {
    const out = await handler(toolsCall('github___get_me', MACHINE));
    expect(out.mcp.transformedGatewayRequest).toBeUndefined();
    expect(out.mcp.transformedGatewayResponse?.body).toMatchObject({
      id: 7,
      result: { isError: true },
    });
  });

  it('short-circuits calls without a decodable JWT', async () => {
    const event = toolsCall('github___get_me', USER);
    event.mcp.gatewayRequest.headers = {} as never;
    const out = await handler(event);
    expect(out.mcp.transformedGatewayResponse?.body.result.isError).toBe(true);
  });

  it('still injects _context for internal targets', async () => {
    const out = await handler(toolsCall('utility-tools___echo', USER));
    expect(out.mcp.transformedGatewayRequest?.body.params.arguments._context).toMatchObject({
      userId: 'user-uuid',
    });
  });
});
