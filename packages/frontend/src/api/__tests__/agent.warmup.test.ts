import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const invoke = vi.fn();

vi.mock('../client/agent-client', () => ({
  agentClient: { invoke },
}));

const SESSION_ID = 'abcdefghij0123456789ABCDEFGHIJ012';

let mod: typeof import('../agent');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('VITE_ENABLE_RUNTIME_WARMUP', 'true');
  mod = await import('../agent');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('warmupAgentRuntime', () => {
  it('posts { warmup: true } with the session header and cancels the body', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    invoke.mockResolvedValueOnce({ body: { cancel } });

    await mod.warmupAgentRuntime(SESSION_ID);

    expect(invoke).toHaveBeenCalledTimes(1);
    const options = invoke.mock.calls[0][0] as RequestInit;
    expect(options.method).toBe('POST');
    expect(
      (options.headers as Record<string, string>)['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']
    ).toBe(SESSION_ID);
    expect(JSON.parse(options.body as string)).toEqual({ warmup: true });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('includes storagePath so the runtime can prefetch the workspace', async () => {
    invoke.mockResolvedValueOnce({ body: null });

    await mod.warmupAgentRuntime(SESSION_ID, '/project');

    const options = invoke.mock.calls[0][0] as RequestInit;
    expect(JSON.parse(options.body as string)).toEqual({ warmup: true, storagePath: '/project' });
  });

  it('warms each session at most once', async () => {
    invoke.mockResolvedValue({ body: null });

    await mod.warmupAgentRuntime(SESSION_ID);
    await mod.warmupAgentRuntime(SESSION_ID);

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('swallows errors', async () => {
    invoke.mockRejectedValueOnce(new Error('network'));

    await expect(mod.warmupAgentRuntime(SESSION_ID)).resolves.toBeUndefined();
  });

  it('does nothing when the feature flag is disabled', async () => {
    vi.stubEnv('VITE_ENABLE_RUNTIME_WARMUP', 'false');

    await mod.warmupAgentRuntime(SESSION_ID);

    expect(invoke).not.toHaveBeenCalled();
  });
});
