import { Context } from 'aws-lambda';
import { extractActualToolName, extractToolName, getContextSummary } from '../context-parser.js';

function makeMockContext(overrides: Partial<Context> = {}): Context {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'test-function',
    functionVersion: '$LATEST',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:test-function',
    memoryLimitInMB: '128',
    awsRequestId: 'test-request-id',
    logGroupName: '/aws/lambda/test-function',
    logStreamName: '2026/01/01/[$LATEST]abcdef',
    getRemainingTimeInMillis: () => 5000,
    done: jest.fn(),
    fail: jest.fn(),
    succeed: jest.fn(),
    ...overrides,
  };
}

describe('extractActualToolName', () => {
  it('strips prefix when delimiter is present', () => {
    expect(extractActualToolName('echo-tool___echo')).toBe('echo');
  });

  it('returns the name unchanged when no delimiter', () => {
    expect(extractActualToolName('echo')).toBe('echo');
  });

  it('uses first delimiter only (multiple delimiters)', () => {
    expect(extractActualToolName('a___b___c')).toBe('b___c');
  });

  it('returns empty string for empty input', () => {
    expect(extractActualToolName('')).toBe('');
  });

  it('returns empty string when input is only the delimiter', () => {
    expect(extractActualToolName('___')).toBe('');
  });

  it('returns tool name when delimiter is at the start', () => {
    expect(extractActualToolName('___echo')).toBe('echo');
  });

  it('returns empty string when delimiter is at the end', () => {
    expect(extractActualToolName('echo___')).toBe('');
  });
});

describe('extractToolName', () => {
  it('returns the tool name from clientContext.custom.bedrockAgentCoreToolName', () => {
    const context = makeMockContext({
      clientContext: {
        custom: { bedrockAgentCoreToolName: 'my-tool___my-action' },
        client: {
          installationId: '',
          appTitle: '',
          appVersionName: '',
          appVersionCode: '',
          appPackageName: '',
        },
        env: { platformVersion: '', platform: '', make: '', model: '', locale: '' },
      },
    });

    expect(extractToolName(context)).toBe('my-action');
  });

  it('returns null when clientContext is missing', () => {
    const context = makeMockContext({ clientContext: undefined });
    expect(extractToolName(context)).toBeNull();
  });

  it('returns null when custom is missing from clientContext', () => {
    const context = makeMockContext({
      clientContext: {
        client: {
          installationId: '',
          appTitle: '',
          appVersionName: '',
          appVersionCode: '',
          appPackageName: '',
        },
        env: { platformVersion: '', platform: '', make: '', model: '', locale: '' },
      } as any,
    });
    expect(extractToolName(context)).toBeNull();
  });

  it('returns null when bedrockAgentCoreToolName is missing', () => {
    const context = makeMockContext({
      clientContext: {
        custom: {},
        client: {
          installationId: '',
          appTitle: '',
          appVersionName: '',
          appVersionCode: '',
          appPackageName: '',
        },
        env: { platformVersion: '', platform: '', make: '', model: '', locale: '' },
      } as any,
    });
    expect(extractToolName(context)).toBeNull();
  });

  it('returns tool name without prefix when prefix is present', () => {
    const context = makeMockContext({
      clientContext: {
        custom: { bedrockAgentCoreToolName: 'athena-tools___athena-query' },
        client: {
          installationId: '',
          appTitle: '',
          appVersionName: '',
          appVersionCode: '',
          appPackageName: '',
        },
        env: { platformVersion: '', platform: '', make: '', model: '', locale: '' },
      },
    });
    expect(extractToolName(context)).toBe('athena-query');
  });

  it('returns tool name as-is when no prefix delimiter', () => {
    const context = makeMockContext({
      clientContext: {
        custom: { bedrockAgentCoreToolName: 'echo' },
        client: {
          installationId: '',
          appTitle: '',
          appVersionName: '',
          appVersionCode: '',
          appPackageName: '',
        },
        env: { platformVersion: '', platform: '', make: '', model: '', locale: '' },
      },
    });
    expect(extractToolName(context)).toBe('echo');
  });
});

describe('getContextSummary', () => {
  it('returns a structured summary with all expected fields', () => {
    const context = makeMockContext({
      clientContext: {
        custom: { bedrockAgentCoreToolName: 'echo' },
        client: {
          installationId: '',
          appTitle: '',
          appVersionName: '',
          appVersionCode: '',
          appPackageName: '',
        },
        env: { platformVersion: '', platform: '', make: '', model: '', locale: '' },
      },
    });

    const summary = getContextSummary(context);

    expect(summary).toMatchObject({
      functionName: 'test-function',
      functionVersion: '$LATEST',
      memoryLimit: '128',
      hasClientContext: true,
    });
    expect(typeof summary.remainingTime).toBe('number');
    expect(Array.isArray(summary.clientContextKeys)).toBe(true);
  });

  it('reports hasClientContext as false when clientContext is absent', () => {
    const context = makeMockContext({ clientContext: undefined });
    const summary = getContextSummary(context);

    expect(summary.hasClientContext).toBe(false);
    expect(summary.clientContextKeys).toEqual([]);
  });

  it('returns remainingTime from getRemainingTimeInMillis', () => {
    const context = makeMockContext({ getRemainingTimeInMillis: () => 3000 });
    const summary = getContextSummary(context);

    expect(summary.remainingTime).toBe(3000);
  });
});
