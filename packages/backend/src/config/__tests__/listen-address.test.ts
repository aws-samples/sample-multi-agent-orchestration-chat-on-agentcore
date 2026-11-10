import { describe, expect, it } from '@jest/globals';
import { parseHttpEndpoint } from '../listen-address.js';

describe('parseHttpEndpoint', () => {
  it('parses IPv4 host:port', () => {
    expect(parseHttpEndpoint('127.0.0.1:8080')).toEqual({ host: '127.0.0.1', port: 8080 });
  });

  it('parses a hostname', () => {
    expect(parseHttpEndpoint('localhost:3000')).toEqual({ host: 'localhost', port: 3000 });
  });

  it('strips brackets from an IPv6 host', () => {
    expect(parseHttpEndpoint('[::1]:8080')).toEqual({ host: '::1', port: 8080 });
  });

  it.each(['8080', 'localhost', '::1:8080', 'host:', 'host:0', 'host:70000', 'host:abc', ''])(
    'rejects %p',
    (value) => {
      expect(() => parseHttpEndpoint(value)).toThrow(/AWS_LAMBDA_HTTP_ENDPOINT/);
    }
  );
});
