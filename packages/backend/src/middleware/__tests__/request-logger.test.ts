import { describe, expect, it } from '@jest/globals';
import { omitCloudFrontHeaders } from '../request-logger.js';

describe('omitCloudFrontHeaders', () => {
  it('drops CloudFront-injected viewer headers and keeps the rest', () => {
    expect(
      omitCloudFrontHeaders({
        'cloudfront-viewer-city': 'Tokyo',
        'cloudfront-viewer-latitude': '35.6',
        'CloudFront-Is-Desktop-Viewer': 'true',
        'user-agent': 'node',
        authorization: '[REDACTED]',
      })
    ).toEqual({ 'user-agent': 'node', authorization: '[REDACTED]' });
  });

  it('treats missing headers as empty', () => {
    expect(omitCloudFrontHeaders(undefined as unknown as Record<string, string>)).toEqual({});
  });
});
