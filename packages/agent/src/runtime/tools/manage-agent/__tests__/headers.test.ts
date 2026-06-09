import { describe, it, expect } from '@jest/globals';
import type { UserId } from '@moca/core';
import {
  createRequestContext,
  runWithContext,
  type RequestContext,
} from '../../../../libs/context/request-context.js';
import { buildRequestHeaders } from '../headers.js';

/**
 * Behavior tests for buildRequestHeaders.
 *
 * The function reads the active RequestContext via getCurrentContext, so each
 * case runs inside `runWithContext` with a real context built by
 * `createRequestContext` (no mocking of request-context anywhere in the repo).
 */
const withContext = <T>(overrides: Partial<RequestContext>, fn: () => T): T => {
  const ctx = { ...createRequestContext(), ...overrides };
  return runWithContext(ctx, fn);
};

describe('buildRequestHeaders', () => {
  it('always sets Authorization and Content-Type', () => {
    withContext({}, () => {
      const headers = buildRequestHeaders('Bearer abc');
      expect(headers.Authorization).toBe('Bearer abc');
      expect(headers['Content-Type']).toBe('application/json');
    });
  });

  it('adds the Id-Token header when ctx.idToken is set', () => {
    withContext({ idToken: 'id-token-xyz' }, () => {
      const headers = buildRequestHeaders('Bearer abc');
      expect(headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token']).toBe('id-token-xyz');
    });
  });

  it('adds X-Target-User-Id when ctx.userId is set', () => {
    withContext({ userId: 'user-123' as UserId }, () => {
      const headers = buildRequestHeaders('Bearer abc');
      expect(headers['X-Target-User-Id']).toBe('user-123');
    });
  });

  it('sets both forwarding headers when idToken and userId are present', () => {
    withContext({ idToken: 'id-token-xyz', userId: 'user-123' as UserId }, () => {
      const headers = buildRequestHeaders('Bearer abc');
      expect(headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token']).toBe('id-token-xyz');
      expect(headers['X-Target-User-Id']).toBe('user-123');
    });
  });

  it('omits both forwarding headers when idToken and userId are absent', () => {
    withContext({}, () => {
      const headers = buildRequestHeaders('Bearer abc');
      expect(headers).not.toHaveProperty('X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token');
      expect(headers).not.toHaveProperty('X-Target-User-Id');
      expect(Object.keys(headers)).toEqual(['Authorization', 'Content-Type']);
    });
  });
});
