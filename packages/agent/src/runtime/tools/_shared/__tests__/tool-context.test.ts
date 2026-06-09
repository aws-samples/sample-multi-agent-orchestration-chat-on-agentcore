import { describe, it, expect } from '@jest/globals';
import type { IdentityId, UserId } from '@moca/core';
import {
  createRequestContext,
  runWithContext,
  type RequestContext,
} from '../../../../libs/context/request-context.js';
import {
  ToolContextError,
  requireUserId,
  requireStoragePath,
  requireIdentityId,
} from '../tool-context.js';

const withContext = <T>(overrides: Partial<RequestContext>, fn: () => T): T => {
  const ctx = { ...createRequestContext(), ...overrides };
  return runWithContext(ctx, fn);
};

describe('requireUserId', () => {
  it('returns the userId when populated', () => {
    withContext({ userId: 'user-123' as UserId }, () => {
      expect(requireUserId()).toBe('user-123');
    });
  });

  it('throws ToolContextError with the exact model-facing message when missing', () => {
    withContext({}, () => {
      // Pin the verbatim message — defineTool surfaces it to the model.
      expect(() => requireUserId()).toThrow(ToolContextError);
      expect(() => requireUserId()).toThrow(
        'User authentication information not found. Please log in again.'
      );
    });
  });

  it('throws ToolContextError when invoked outside any request scope', () => {
    expect(() => requireUserId()).toThrow(ToolContextError);
  });
});

describe('requireStoragePath', () => {
  it('returns the default "/" populated by createRequestContext', () => {
    withContext({}, () => {
      expect(requireStoragePath()).toBe('/');
    });
  });

  it('returns the overridden path', () => {
    withContext({ storagePath: '/projects/a' }, () => {
      expect(requireStoragePath()).toBe('/projects/a');
    });
  });

  it('throws ToolContextError outside a request scope', () => {
    expect(() => requireStoragePath()).toThrow(ToolContextError);
  });
});

describe('requireIdentityId', () => {
  it('returns the identityId when populated', () => {
    withContext({ identityId: 'ap-1:uuid' as IdentityId }, () => {
      expect(requireIdentityId()).toBe('ap-1:uuid');
    });
  });

  it('throws ToolContextError with the exact model-facing message when missing', () => {
    withContext({}, () => {
      expect(() => requireIdentityId()).toThrow(ToolContextError);
      expect(() => requireIdentityId()).toThrow(
        'Could not determine the current user identity. ' +
          'Identity Pool identityId has not been resolved for this request.'
      );
    });
  });

  it('throws ToolContextError when invoked outside any request scope', () => {
    expect(() => requireIdentityId()).toThrow(ToolContextError);
  });
});
