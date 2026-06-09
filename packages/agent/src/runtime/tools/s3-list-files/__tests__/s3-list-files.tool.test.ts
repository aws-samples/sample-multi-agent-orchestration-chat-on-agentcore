import { describe, expect, it } from '@jest/globals';
import { config } from '../../../../config/index.js';
import {
  createRequestContext,
  runWithContext,
  type RequestContext,
} from '../../../../libs/context/request-context.js';
import { s3ListFilesTool } from '../index.js';

/**
 * Behavior tests for the s3_list_files handler, exercised through
 * `defineTool`'s `invoke()` seam.
 *
 * These cover the context-validation and scope branches that resolve BEFORE
 * any S3 round-trip, so no AWS access or mocking is required:
 *
 * - no request context        → `requireUserId()` guidance (verbatim swap),
 * - path outside allowed scope → access-denied guidance (preserved string),
 * - context without identityId → `requireIdentityId()` guidance (verbatim swap).
 *
 * `requireUserId` / `requireIdentityId` throw `ToolContextError`; `defineTool`
 * surfaces those messages verbatim to the model.
 *
 * The scope and identity branches are reached only once the bucket-config check
 * has passed, so when `USER_STORAGE_BUCKET_NAME` is unset (some CI envs) the
 * handler short-circuits with the bucket-config guidance instead. The tests
 * adapt to that to stay environment-independent while still asserting the exact
 * swapped strings whenever the bucket IS configured (the real scenario).
 */
describe('s3ListFilesTool', () => {
  const bucketConfigured = !!config.USER_STORAGE_BUCKET_NAME;
  const BUCKET_NOT_SET =
    'Error: Storage configuration incomplete (USER_STORAGE_BUCKET_NAME not set)';

  it('returns the login guidance when there is no request context', async () => {
    // requireUserId() runs before the bucket check, so this is unconditional.
    const result = await s3ListFilesTool.invoke({
      path: '/',
      recursive: false,
      maxResults: 100,
      includePresignedUrls: false,
      presignedUrlExpiry: 3600,
    });

    expect(result).toBe('User authentication information not found. Please log in again.');
  });

  it('denies a path outside the permitted directory', async () => {
    const ctx: RequestContext = {
      ...createRequestContext(),
      userId: 'user-1' as RequestContext['userId'],
      storagePath: 'projects/allowed',
    };

    const result = await runWithContext(ctx, () =>
      s3ListFilesTool.invoke({
        path: '/projects/forbidden',
        recursive: false,
        maxResults: 100,
        includePresignedUrls: false,
        presignedUrlExpiry: 3600,
      })
    );

    if (bucketConfigured) {
      expect(result).toBe(
        'Access denied: The specified path "/projects/forbidden" is outside the permitted directory ("projects/allowed").\n\nPlease specify a path under the allowed directory.'
      );
    } else {
      expect(result).toBe(BUCKET_NOT_SET);
    }
  });

  it('returns the identity guidance when identityId is unresolved', async () => {
    // userId + storagePath present, but identityId absent → after the bucket and
    // scope checks pass (root allows all), requireIdentityId() throws.
    const ctx: RequestContext = {
      ...createRequestContext(),
      userId: 'user-1' as RequestContext['userId'],
      storagePath: '/',
    };

    const result = await runWithContext(ctx, () =>
      s3ListFilesTool.invoke({
        path: '/',
        recursive: false,
        maxResults: 100,
        includePresignedUrls: false,
        presignedUrlExpiry: 3600,
      })
    );

    if (bucketConfigured) {
      expect(result).toBe(
        'Could not determine the current user identity. ' +
          'Identity Pool identityId has not been resolved for this request.'
      );
    } else {
      expect(result).toBe(BUCKET_NOT_SET);
    }
  });
});
