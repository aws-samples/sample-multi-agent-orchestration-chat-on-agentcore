import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isTrustedAuthorizationUrl,
  rememberOAuthReturnPath,
  takeOAuthReturnPath,
} from '../oauth-authorization';

const URL_OK =
  'https://bedrock-agentcore.us-west-2.amazonaws.com/identities/oauth2/authorize?request_uri=x';

describe('isTrustedAuthorizationUrl', () => {
  it('accepts the AgentCore Identity authorize endpoint of the region', () => {
    expect(isTrustedAuthorizationUrl(URL_OK, 'us-west-2')).toBe(true);
  });

  it.each([
    ['another region', URL_OK.replace('us-west-2', 'eu-west-1')],
    [
      'look-alike host',
      'https://bedrock-agentcore.us-west-2.amazonaws.com.evil.example/identities/',
    ],
    ['http', URL_OK.replace('https:', 'http:')],
    ['javascript scheme', 'javascript:alert(1)'],
    ['other path', 'https://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/x'],
  ])('rejects %s', (_label, url) => {
    expect(isTrustedAuthorizationUrl(url, 'us-west-2')).toBe(false);
  });
});

describe('OAuth return path', () => {
  beforeEach(() => {
    // vitest runs in the node environment here; a Map-backed stub is enough.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    });
  });

  it('returns to the originating chat session once', () => {
    rememberOAuthReturnPath('0192abcd-ef01-7000-8000-000000000001');
    expect(takeOAuthReturnPath()).toBe('/chat/0192abcd-ef01-7000-8000-000000000001');
    expect(takeOAuthReturnPath()).toBe('/chat');
  });

  it('falls back to /chat for anything but a chat session path', () => {
    localStorage.setItem('moca-oauth-return-path', 'https://evil.example/');
    expect(takeOAuthReturnPath()).toBe('/chat');
    localStorage.setItem('moca-oauth-return-path', '//evil.example');
    expect(takeOAuthReturnPath()).toBe('/chat');
  });
});
