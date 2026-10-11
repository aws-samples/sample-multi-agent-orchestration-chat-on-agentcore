import { describe, it, expect } from '@jest/globals';
import {
  drainAuthorizationRequests,
  isTrustedAuthorizationUrl,
  isUserDelegatedTool,
  parseUrlElicitation,
  queueAuthorizationRequest,
} from '../authorization.js';
import { createRequestContext, runWithContext } from '../../context/request-context.js';

const REGION = 'us-west-2';
const AUTH_URL =
  'https://bedrock-agentcore.us-west-2.amazonaws.com/identities/oauth2/authorize?request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Aabc';

function elicitationError(url: string, extra: Record<string, unknown> = {}) {
  return {
    code: -32042,
    message: 'This request requires more information.',
    data: { elicitations: [{ mode: 'url', elicitationId: 'e-1', url, ...extra }] },
  };
}

describe('isTrustedAuthorizationUrl', () => {
  it('accepts the AgentCore Identity authorize endpoint of the region', () => {
    expect(isTrustedAuthorizationUrl(AUTH_URL, REGION)).toBe(true);
  });

  it.each([
    ['another region', AUTH_URL.replace('us-west-2', 'us-east-1')],
    [
      'look-alike host',
      'https://bedrock-agentcore.us-west-2.amazonaws.com.evil.example/identities/x',
    ],
    ['plain http', AUTH_URL.replace('https:', 'http:')],
    ['non-identity path', 'https://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/x'],
    ['garbage', 'not a url'],
  ])('rejects %s', (_label, url) => {
    expect(isTrustedAuthorizationUrl(url, REGION)).toBe(false);
  });
});

describe('parseUrlElicitation', () => {
  it('extracts the request and the target name from -32042', () => {
    expect(parseUrlElicitation(elicitationError(AUTH_URL), 'github___get_me', REGION)).toEqual({
      url: AUTH_URL,
      elicitationId: 'e-1',
      targetName: 'github',
    });
  });

  it('ignores other error codes', () => {
    expect(
      parseUrlElicitation({ ...elicitationError(AUTH_URL), code: -32602 }, 'github___x', REGION)
    ).toBeUndefined();
  });

  it('ignores untrusted URLs', () => {
    expect(
      parseUrlElicitation(elicitationError('https://evil.example/login'), 'github___x', REGION)
    ).toBeUndefined();
  });

  it('ignores non-url elicitation modes', () => {
    expect(
      parseUrlElicitation(elicitationError(AUTH_URL, { mode: 'form' }), 'github___x', REGION)
    ).toBeUndefined();
  });
});

describe('authorization request queue', () => {
  it('drains once and de-duplicates per target', () => {
    const context = { ...createRequestContext(), surfacesAuthorizationPrompts: true };
    runWithContext(context, () => {
      const request = { url: AUTH_URL, elicitationId: 'e-1', targetName: 'github' };
      expect(queueAuthorizationRequest(request)).toBe(true);
      queueAuthorizationRequest({ ...request, elicitationId: 'e-2' });
      expect(drainAuthorizationRequests()).toEqual([{ ...request, elicitationId: 'e-2' }]);
      expect(drainAuthorizationRequests()).toEqual([]);
    });
  });

  it('is a no-op outside a request context', () => {
    expect(
      queueAuthorizationRequest({ url: AUTH_URL, elicitationId: 'e', targetName: 'github' })
    ).toBe(false);
    expect(drainAuthorizationRequests()).toEqual([]);
  });

  it('refuses when no stream will surface the prompt (e.g. sub-agent context)', () => {
    runWithContext(createRequestContext(), () => {
      expect(
        queueAuthorizationRequest({ url: AUTH_URL, elicitationId: 'e', targetName: 'github' })
      ).toBe(false);
      expect(drainAuthorizationRequests()).toEqual([]);
    });
  });
});

describe('isUserDelegatedTool', () => {
  it('matches only the `{target}___` prefix', () => {
    expect(isUserDelegatedTool('github___get_me', ['github'])).toBe(true);
    expect(isUserDelegatedTool('github-tools___x', ['github'])).toBe(false);
    expect(isUserDelegatedTool('github___get_me', [])).toBe(false);
  });
});
