/**
 * Tests for middleware/gzip-response.ts
 *
 * Coverage:
 *  1. negotiateEncoding() – RFC 7231 §5.3.4 parsing incl. q>1 rejection
 *  2. sessionHistoryGzipMiddleware() – unit tests (mocked req/res)
 *     a. basic compress / no-compress / identity paths
 *     b. small body with identity;q=0 MUST gzip (issue 2)
 *     c. Vary: Accept-Encoding always set; existing Vary: Origin preserved
 *     d. Content-Encoding absent on 406/413 error bodies
 *  3. Integration: real Express app + Node.js http client
 *     a. large body with real router (gzip middleware wired as in sessions.ts)
 *     b. LWA BUFFERED binary-encoding simulation (Content-Encoding → base64)
 *     c. Node.js built-in fetch auto-decompression equivalence
 *     d. small body
 *  4. Integration: actual sessions router with mocked repository + memory
 *     a. body shape (ok() wrapper preserved through gzip)
 *     b. owner rejection (session not found → 404)
 *  5. Synthetic 622-message (~13 MB) fixture – compression metrics + round-trip
 *  6. Boundary regression: double-JSON escape inflates identity body size
 *
 * NOTE: Live E2E (real Lambda / API Gateway / browser auto-decompression)
 * was NOT performed.  §3b simulates the LWA binary-encoding path
 * (Content-Encoding header presence → convert_to_binary → isBase64Encoded=true,
 * per lambda_http 1.1.1 response.rs:322).  §3c shows that Node.js built-in fetch
 * auto-decompresses gzip responses, equivalent to browser behaviour.
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';

// ── Jest module mocks (hoisted before imports) ────────────────────────────────
// Mocks for the sessions-router integration suite (§4).
// These must appear before any import so ts-jest hoists them correctly.
jest.mock('../../repositories/sessions/sessions-repository.factory', () => ({
  getSessionsRepository: jest.fn(),
}));
jest.mock('../../services/agentcore-memory', () => ({
  createAgentCoreMemoryServiceForRequest: jest.fn(),
}));
jest.mock('../../config/index', () => ({
  config: {
    AGENTCORE_MEMORY_ID: 'test-memory-id',
    CORS_ALLOWED_ORIGINS: '',
    NODE_ENV: 'test',
  },
  isDevelopment: jest.fn(() => false),
}));

import { createGunzip, gzip as gzipCb } from 'zlib';
import { promisify } from 'util';
import { createServer, type Server, type IncomingMessage, request as httpRequest } from 'http';
import express, { type Request, type Response, type NextFunction } from 'express';
import { negotiateEncoding, sessionHistoryGzipMiddleware } from '../gzip-response.js';
import { getSessionsRepository } from '../../repositories/sessions/sessions-repository.factory.js';
import { createAgentCoreMemoryServiceForRequest } from '../../services/agentcore-memory.js';
import sessionsRouter from '../../routes/sessions.js';
import { errorHandlerMiddleware } from '../../middleware/error-handler.js';

const gzipAsync = promisify(gzipCb);

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeReq(acceptEncoding?: string): Partial<Request> {
  return {
    method: 'GET',
    headers: acceptEncoding !== undefined ? { 'accept-encoding': acceptEncoding } : {},
    requestId: 'test-request-id',
  } as Partial<Request>;
}

function makeRes() {
  const headers: Record<string, string | number | string[]> = {};
  let statusCode = 200;
  let sentBody: Buffer | null = null;
  let ended = false;

  const res: Partial<Response> & { _headers: typeof headers; _body: typeof sentBody } = {
    _headers: headers,
    _body: null,
    statusCode,
    status(code: number) {
      statusCode = code;
      this.statusCode = code;
      return this as unknown as Response;
    },
    setHeader(name: string, value: string | number | string[]) {
      headers[name.toLowerCase()] = value;
      return this as unknown as Response;
    },
    removeHeader(name: string) {
      delete headers[name.toLowerCase()];
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    getHeaders() {
      return { ...headers };
    },
    vary(field: string) {
      const existing = headers['vary'];
      if (!existing) {
        headers['vary'] = field;
      } else {
        const parts = (Array.isArray(existing) ? existing : [String(existing)])
          .join(', ')
          .split(',')
          .map((s) => s.trim());
        if (!parts.map((p) => p.toLowerCase()).includes(field.toLowerCase())) {
          headers['vary'] = parts.concat(field).join(', ');
        }
      }
      return this as unknown as Response;
    },
    json(body: unknown) {
      const s = JSON.stringify(body);
      sentBody = Buffer.from(s, 'utf-8');
      this._body = sentBody;
      ended = true;
      return this as unknown as Response;
    },
    end(chunk?: Buffer | string) {
      if (chunk instanceof Buffer) {
        sentBody = chunk;
      } else if (typeof chunk === 'string') {
        sentBody = Buffer.from(chunk, 'utf-8');
      }
      this._body = sentBody;
      ended = true;
      return this as unknown as Response;
    },
    headersSent: false,
  };

  return {
    res: res as unknown as Response,
    headers,
    getBody: () => sentBody,
    isEnded: () => ended,
  };
}

function waitForBody(getBody: () => Buffer | null, timeoutMs = 3000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const id = setInterval(() => {
      const body = getBody();
      if (body) {
        clearInterval(id);
        resolve(body);
      } else if (Date.now() >= deadline) {
        clearInterval(id);
        reject(new Error('waitForBody timed out'));
      }
    }, 10);
  });
}

function gunzipBuffer(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const gz = createGunzip();
    gz.on('data', (d: Buffer) => chunks.push(d));
    gz.on('end', () => resolve(Buffer.concat(chunks)));
    gz.on('error', reject);
    gz.end(buf);
  });
}

// ─── 1. negotiateEncoding ─────────────────────────────────────────────────────

describe('negotiateEncoding', () => {
  it('returns identity when Accept-Encoding is absent', () => {
    expect(negotiateEncoding(undefined)).toBe('identity');
  });

  it('returns identity when Accept-Encoding is empty string', () => {
    expect(negotiateEncoding('')).toBe('identity');
  });

  it('returns gzip for "gzip"', () => {
    expect(negotiateEncoding('gzip')).toBe('gzip');
  });

  it('returns gzip for "GZIP" (case-insensitive)', () => {
    expect(negotiateEncoding('GZIP')).toBe('gzip');
  });

  it('returns gzip for "GZip, deflate"', () => {
    expect(negotiateEncoding('GZip, deflate')).toBe('gzip');
  });

  it('returns gzip for "gzip;q=1.0, identity;q=0.5"', () => {
    expect(negotiateEncoding('gzip;q=1.0, identity;q=0.5')).toBe('gzip');
  });

  it('returns identity for "identity"', () => {
    expect(negotiateEncoding('identity')).toBe('identity');
  });

  it('returns identity for "identity, gzip;q=0"', () => {
    expect(negotiateEncoding('identity, gzip;q=0')).toBe('identity');
  });

  it('returns identity for "gzip;q=0" (gzip refused, identity default)', () => {
    expect(negotiateEncoding('gzip;q=0')).toBe('identity');
  });

  it('returns null for "gzip;q=0, identity;q=0" (all refused)', () => {
    expect(negotiateEncoding('gzip;q=0, identity;q=0')).toBeNull();
  });

  it('returns gzip for wildcard "*"', () => {
    expect(negotiateEncoding('*')).toBe('gzip');
  });

  it('returns null for "*;q=0" (wildcard refuses all including identity)', () => {
    expect(negotiateEncoding('*;q=0')).toBeNull();
  });

  it('returns identity for "*;q=0, identity;q=1"', () => {
    expect(negotiateEncoding('*;q=0, identity;q=1')).toBe('identity');
  });

  it('returns gzip for "*;q=0, gzip;q=1"', () => {
    expect(negotiateEncoding('*;q=0, gzip;q=1')).toBe('gzip');
  });

  it('prefers gzip over identity when both are listed with equal q', () => {
    expect(negotiateEncoding('gzip, identity')).toBe('gzip');
  });

  it('handles array header (multiple Accept-Encoding values)', () => {
    expect(negotiateEncoding(['gzip', 'deflate'])).toBe('gzip');
  });

  // RFC 7231 §5.3.1: q > 1 is invalid – must NOT be treated as accepted
  it('treats q>1 as refused (not accepted)', () => {
    expect(negotiateEncoding('gzip;q=1.5')).toBe('identity');
  });

  it('treats q=2.0 as refused', () => {
    expect(negotiateEncoding('gzip;q=2.0, identity;q=0')).toBeNull();
  });

  it('returns gzip when only identity has invalid q>1 (identity treated as refused)', () => {
    expect(negotiateEncoding('gzip;q=0.9, identity;q=1.1')).toBe('gzip');
  });

  // Invalid q syntax regressions – must be treated as q=0 (refused), not q=1
  it('q=wat: non-numeric q value → treated as refused', () => {
    expect(negotiateEncoding('gzip;q=wat')).toBe('identity');
  });

  it('q=-1: negative q value → treated as refused', () => {
    expect(negotiateEncoding('gzip;q=-1')).toBe('identity');
  });

  it('q=NaN: literal NaN string → treated as refused', () => {
    expect(negotiateEncoding('gzip;q=NaN')).toBe('identity');
  });

  it('q=wat with identity;q=0: both refused → 406', () => {
    expect(negotiateEncoding('gzip;q=wat, identity;q=0')).toBeNull();
  });

  it('duplicate q=: conservative → treated as refused', () => {
    expect(negotiateEncoding('gzip;q=0.9;q=0.8')).toBe('identity');
  });
});

// ─── 2. sessionHistoryGzipMiddleware unit tests ───────────────────────────────

describe('sessionHistoryGzipMiddleware (unit)', () => {
  it('calls next() to continue the middleware chain', () => {
    const req = makeReq('gzip') as Request;
    const { res } = makeRes();
    let nextCalled = false;
    sessionHistoryGzipMiddleware(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it('compresses large JSON body when gzip accepted', async () => {
    const req = makeReq('gzip') as Request;
    const { res, headers, getBody } = makeRes();
    sessionHistoryGzipMiddleware(req, res, (() => {}) as NextFunction);

    const largeBody = {
      events: Array.from({ length: 500 }, (_, i) => ({ id: i, text: 'x'.repeat(100) })),
    };

    res.json(largeBody);
    const body = await waitForBody(getBody);

    expect(headers['content-encoding']).toBe('gzip');
    expect(headers['content-type']).toBe('application/json');
    // Vary must include Accept-Encoding
    expect(String(headers['vary'] ?? '')).toContain('Accept-Encoding');

    const decompressed = await gunzipBuffer(body);
    const parsed = JSON.parse(decompressed.toString('utf-8')) as typeof largeBody;
    expect(parsed.events).toHaveLength(500);
  });

  it('does NOT compress small body when identity is allowed (Accept-Encoding: gzip)', async () => {
    const req = makeReq('gzip') as Request;
    const { res, headers } = makeRes();
    sessionHistoryGzipMiddleware(req, res, (() => {}) as NextFunction);
    res.json({ events: [{ id: 1, text: 'hello' }] });
    await Promise.resolve();

    expect(headers['content-encoding']).toBeUndefined();
    expect(String(headers['vary'] ?? '')).toContain('Accept-Encoding');
  });

  // Issue 2: small body with identity;q=0 MUST still be gzip-compressed
  it('DOES compress small body when identity is forbidden (gzip, identity;q=0)', async () => {
    const req = makeReq('gzip, identity;q=0') as Request;
    const { res, headers, getBody } = makeRes();
    sessionHistoryGzipMiddleware(req, res, (() => {}) as NextFunction);

    // Body well below MIN_COMPRESS_BYTES but identity is refused
    const smallBody = { events: [{ id: 1, text: 'hi' }] };
    res.json(smallBody);
    const body = await waitForBody(getBody);

    expect(headers['content-encoding']).toBe('gzip');
    const decompressed = await gunzipBuffer(body);
    const parsed = JSON.parse(decompressed.toString('utf-8')) as typeof smallBody;
    expect(parsed.events[0]!.text).toBe('hi');
  });

  it('also compresses small body when *;q=0 and gzip;q=1 (identity forbidden)', async () => {
    const req = makeReq('*;q=0, gzip;q=1') as Request;
    const { res, headers, getBody } = makeRes();
    sessionHistoryGzipMiddleware(req, res, (() => {}) as NextFunction);
    res.json({ events: [{ id: 2, text: 'tiny' }] });
    await waitForBody(getBody);

    expect(headers['content-encoding']).toBe('gzip');
  });

  it('sends plain identity JSON when only identity accepted', async () => {
    const req = makeReq('identity') as Request;
    const { res, headers } = makeRes();
    sessionHistoryGzipMiddleware(req, res, (() => {}) as NextFunction);
    res.json({ events: [], metadata: { requestId: 'y', timestamp: '' } });
    await Promise.resolve();

    expect(headers['content-encoding']).toBeUndefined();
    expect(String(headers['vary'] ?? '')).toContain('Accept-Encoding');
  });

  it('returns 406 when all encodings refused', async () => {
    const req = makeReq('gzip;q=0, identity;q=0') as Request;
    const { res } = makeRes();
    let status406 = false;
    (res as unknown as { status: (n: number) => Response }).status = (n) => {
      if (n === 406) status406 = true;
      return res;
    };
    sessionHistoryGzipMiddleware(req, res, (() => {}) as NextFunction);
    res.json({ events: [] });
    await Promise.resolve();
    expect(status406).toBe(true);
  });

  it('does not set Content-Encoding on 406 error response', async () => {
    const req = makeReq('gzip;q=0, identity;q=0') as Request;
    const { res, headers } = makeRes();
    sessionHistoryGzipMiddleware(req, res, (() => {}) as NextFunction);
    res.json({ events: [] });
    await Promise.resolve();
    expect(headers['content-encoding']).toBeUndefined();
  });

  // Issue 3: Vary: Accept-Encoding must merge with existing Vary: Origin
  it('preserves existing Vary: Origin when adding Vary: Accept-Encoding', async () => {
    const req = makeReq('gzip') as Request;
    const { res, headers } = makeRes();
    // Pre-set Vary: Origin (as CORS middleware would do)
    res.setHeader('Vary', 'Origin');
    sessionHistoryGzipMiddleware(req, res, (() => {}) as NextFunction);
    res.json({ events: [{ id: 1, text: 'hello' }] });
    await Promise.resolve();

    const vary = String(headers['vary'] ?? '');
    expect(vary).toContain('Origin');
    expect(vary).toContain('Accept-Encoding');
  });

  it('sets Vary: Accept-Encoding even for no-accept-encoding (identity default)', async () => {
    const req = makeReq(undefined) as Request;
    const { res, headers } = makeRes();
    sessionHistoryGzipMiddleware(req, res, (() => {}) as NextFunction);
    res.json({ events: [] });
    await Promise.resolve();
    expect(String(headers['vary'] ?? '')).toContain('Accept-Encoding');
  });

  it('sets Vary on 406 error path', async () => {
    const req = makeReq('gzip;q=0, identity;q=0') as Request;
    const { res, headers } = makeRes();
    sessionHistoryGzipMiddleware(req, res, (() => {}) as NextFunction);
    res.json({ events: [] });
    await Promise.resolve();
    expect(String(headers['vary'] ?? '')).toContain('Accept-Encoding');
  });
});

// ─── 3. Integration: real Express app ─────────────────────────────────────────

function buildTestApp(
  responseBody: unknown,
  statusCode = 200
): { listen: () => Promise<{ server: Server; port: number }> } {
  const app = express();
  app.use(express.json({ limit: '100mb' }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Record<string, unknown>).requestId = 'integ-test-id';
    (req as Record<string, unknown>).log = { warn: () => {}, error: () => {}, info: () => {} };
    next();
  });
  // Mirror sessions.ts: CORS middleware sets Vary: Origin first
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Vary', 'Origin');
    next();
  });
  app.get(
    '/sessions/:sessionId/events',
    sessionHistoryGzipMiddleware,
    (_req: Request, res: Response) => {
      res.status(statusCode).json(responseBody);
    }
  );
  return {
    listen: () =>
      new Promise((resolve) => {
        const server = createServer(app);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as { port: number };
          resolve({ server, port: addr.port });
        });
      }),
  };
}

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, headers, method: 'GET' },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const largeEvents = Array.from({ length: 80 }, (_, i) => ({
  eventId: `evt-${i}`,
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `Message ${i}: ${'こんにちは、世界！ '.repeat(20)} ${' Hello World '.repeat(20)}`,
  createdAt: new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString(),
}));
const largeBody = {
  events: largeEvents,
  metadata: {
    requestId: 'integ-1',
    timestamp: new Date().toISOString(),
    count: largeEvents.length,
  },
};

describe('sessionHistoryGzipMiddleware (integration through real Express)', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const { listen } = buildTestApp(largeBody);
    ({ server, port } = await listen());
  });

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  );

  it('returns 200 with Content-Encoding: gzip', async () => {
    const { status, headers } = await httpGet(port, '/sessions/test/events', {
      'Accept-Encoding': 'gzip',
    });
    expect(status).toBe(200);
    expect(headers['content-encoding']).toBe('gzip');
    expect(headers['content-type']).toBe('application/json');
  });

  it('Vary header contains both Origin (CORS) and Accept-Encoding', async () => {
    const { headers } = await httpGet(port, '/sessions/test/events', {
      'Accept-Encoding': 'gzip',
    });
    const vary = headers['vary'] ?? '';
    expect(vary).toContain('Origin');
    expect(vary).toContain('Accept-Encoding');
  });

  it('body is valid gzip that round-trips to original JSON', async () => {
    const { body, headers } = await httpGet(port, '/sessions/test/events', {
      'Accept-Encoding': 'gzip',
    });
    expect(headers['content-encoding']).toBe('gzip');
    const decompressed = await gunzipBuffer(body);
    const parsed = JSON.parse(decompressed.toString('utf-8')) as typeof largeBody;
    expect(parsed.events).toHaveLength(largeEvents.length);
    expect(parsed.events[0]).toEqual(largeEvents[0]);
    expect(parsed.events[largeEvents.length - 1]).toEqual(largeEvents[largeEvents.length - 1]);
  });

  it('round-trip preserves UTF-8 Japanese content', async () => {
    const { body } = await httpGet(port, '/sessions/test/events', {
      'Accept-Encoding': 'gzip',
    });
    const decompressed = await gunzipBuffer(body);
    const parsed = JSON.parse(decompressed.toString('utf-8')) as typeof largeBody;
    expect(parsed.events[0]!.content).toContain('こんにちは、世界！');
  });

  it('returns plain JSON when Accept-Encoding: identity', async () => {
    const { status, headers, body } = await httpGet(port, '/sessions/test/events', {
      'Accept-Encoding': 'identity',
    });
    expect(status).toBe(200);
    expect(headers['content-encoding']).toBeUndefined();
    const parsed = JSON.parse(body.toString('utf-8')) as typeof largeBody;
    expect(parsed.events).toHaveLength(largeEvents.length);
  });

  it('returns plain JSON when Accept-Encoding omitted', async () => {
    const { status, headers } = await httpGet(port, '/sessions/test/events');
    expect(status).toBe(200);
    expect(headers['content-encoding']).toBeUndefined();
  });

  it('returns 406 for gzip;q=0, identity;q=0', async () => {
    const { status } = await httpGet(port, '/sessions/test/events', {
      'Accept-Encoding': 'gzip;q=0, identity;q=0',
    });
    expect(status).toBe(406);
  });

  it('406 error body has no Content-Encoding', async () => {
    const { headers, body } = await httpGet(port, '/sessions/test/events', {
      'Accept-Encoding': 'gzip;q=0, identity;q=0',
    });
    expect(headers['content-encoding']).toBeUndefined();
    const parsed = JSON.parse(body.toString('utf-8')) as { code: string };
    expect(parsed.code).toBe('NOT_ACCEPTABLE');
    expect(body.length).toBeLessThan(1024);
  });

  it('Content-Length header matches actual compressed byte count', async () => {
    const { headers, body } = await httpGet(port, '/sessions/test/events', {
      'Accept-Encoding': 'gzip',
    });
    const reported = parseInt(headers['content-length'] ?? '0', 10);
    expect(reported).toBeGreaterThan(0);
    expect(reported).toBe(body.length);
  });

  // §3b: LWA BUFFERED binary-encoding simulation
  // LWA v1.0.0 (lambda_http 1.1.1) response.rs:322:
  //   if headers.get(CONTENT_ENCODING).is_some() { return convert_to_binary(self); }
  // Presence of Content-Encoding is sufficient – LWA sets isBase64Encoded=true
  // and base64-encodes the body in the Lambda proxy response JSON.
  // Source: https://docs.rs/crate/lambda_http/1.1.1/source/src/response.rs
  //         LWA v1.0.0 Cargo.lock (lambda_http 1.1.1)
  it('§3b: LWA binary-encoding: Content-Encoding header present → base64 path simulation', async () => {
    const { body, headers } = await httpGet(port, '/sessions/test/events', {
      'Accept-Encoding': 'gzip',
    });
    // Middleware sets Content-Encoding: gzip – this alone triggers LWA binary path.
    expect(headers['content-encoding']).toBe('gzip');

    // Simulate: LWA sees Content-Encoding → convert_to_binary → base64-encode.
    const b64 = body.toString('base64');
    const lambdaProxy = { statusCode: 200, body: b64, isBase64Encoded: true };
    // API Gateway v2 base64-decodes before forwarding gzip bytes to the client.
    const decoded = Buffer.from(lambdaProxy.body, 'base64');
    expect(decoded.equals(body)).toBe(true); // lossless round-trip

    const decompressed = await gunzipBuffer(decoded);
    const parsed = JSON.parse(decompressed.toString('utf-8')) as typeof largeBody;
    expect(parsed.events).toHaveLength(largeEvents.length);
  });

  // §3c: Node.js built-in fetch (undici) auto-decompresses gzip responses,
  // equivalent to browser fetch() behaviour.
  it('§3c: Node.js fetch() auto-decompresses gzip response (equivalent to browser)', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/sessions/test/events`, {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    expect(response.ok).toBe(true);
    const data = (await response.json()) as typeof largeBody;
    expect(data.events).toHaveLength(largeEvents.length);
    expect(data.events[0]!.content).toContain('こんにちは、世界！');
  });
});

describe('sessionHistoryGzipMiddleware (integration – small response)', () => {
  const smallBody = {
    events: [{ eventId: 'e1', role: 'user', content: 'hi', createdAt: '2025-01-01T00:00:00Z' }],
    metadata: { requestId: 'small-1', timestamp: '2025-01-01T00:00:00Z', count: 1 },
  };

  let server: Server;
  let port: number;

  beforeAll(async () => {
    const { listen } = buildTestApp(smallBody);
    ({ server, port } = await listen());
  });

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  );

  it('does not compress small responses when identity is allowed', async () => {
    const { status, headers } = await httpGet(port, '/sessions/s/events', {
      'Accept-Encoding': 'gzip',
    });
    expect(status).toBe(200);
    expect(headers['content-encoding']).toBeUndefined();
  });

  it('DOES compress small response when identity;q=0 (identity forbidden)', async () => {
    const { status, headers, body } = await httpGet(port, '/sessions/s/events', {
      'Accept-Encoding': 'gzip, identity;q=0',
    });
    expect(status).toBe(200);
    expect(headers['content-encoding']).toBe('gzip');
    const decompressed = await gunzipBuffer(body);
    const parsed = JSON.parse(decompressed.toString('utf-8')) as typeof smallBody;
    expect(parsed.events[0]!.content).toBe('hi');
  });

  it('small identity response is valid JSON', async () => {
    const { body } = await httpGet(port, '/sessions/s/events', {
      'Accept-Encoding': 'identity',
    });
    const parsed = JSON.parse(body.toString('utf-8')) as typeof smallBody;
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]!.content).toBe('hi');
  });
});

// ─── 4. Integration: actual sessions router with mocked deps ──────────────────

describe('sessionHistoryGzipMiddleware (sessions router with mocked dependencies)', () => {
  const mockGetSessionsRepository = getSessionsRepository as jest.MockedFunction<
    typeof getSessionsRepository
  >;
  const mockCreateMemoryService = createAgentCoreMemoryServiceForRequest as jest.MockedFunction<
    typeof createAgentCoreMemoryServiceForRequest
  >;

  const TEST_ACTOR = 'user-test-actor';
  // Session IDs must be exactly 33 alphanumeric characters (SESSION_ID_PATTERN = /^[a-zA-Z0-9]{33}$/)
  const TEST_SESSION_ID = 'abcdefghijklmnopqrstuvwxyz1234567';

  const sampleEvents = Array.from({ length: 40 }, (_, i) => ({
    eventId: `e-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Event ${i}: ${'test content '.repeat(30)}`,
    createdAt: new Date(Date.UTC(2025, 0, i + 1)).toISOString(),
  }));

  function buildSessionsApp(): { listen: () => Promise<{ server: Server; port: number }> } {
    const app = express();
    app.use(express.json());

    // Fake auth middleware: populates identityId, requestId, log
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const r = req as unknown as Record<string, unknown>;
      r['identityId'] = TEST_ACTOR;
      r['requestId'] = 'sessions-test-req';
      r['log'] = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
      next();
    });

    app.use('/sessions', sessionsRouter);
    app.use(errorHandlerMiddleware);

    return {
      listen: () =>
        new Promise((resolve) => {
          const server = createServer(app);
          server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ server, port: addr.port });
          });
        }),
    };
  }

  let server: Server;
  let port: number;

  beforeAll(async () => {
    const { listen } = buildSessionsApp();
    ({ server, port } = await listen());
  });

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns gzip-compressed ok() envelope with events array (body shape preserved)', async () => {
    // Session exists (owner check passes)
    mockGetSessionsRepository.mockReturnValue({
      isConfigured: () => true,
      getSession: jest.fn(async () => ({ sessionId: TEST_SESSION_ID, actorId: TEST_ACTOR })),
    } as unknown as ReturnType<typeof getSessionsRepository>);

    mockCreateMemoryService.mockResolvedValue({
      getSessionEvents: jest.fn(async () => sampleEvents),
    } as unknown as Awaited<ReturnType<typeof createAgentCoreMemoryServiceForRequest>>);

    const { status, headers, body } = await httpGet(port, `/sessions/${TEST_SESSION_ID}/events`, {
      'Accept-Encoding': 'gzip',
    });
    expect(status).toBe(200);
    expect(headers['content-encoding']).toBe('gzip');

    const decompressed = await gunzipBuffer(body);
    const parsed = JSON.parse(decompressed.toString('utf-8')) as {
      events: typeof sampleEvents;
      metadata: { requestId: string; timestamp: string };
    };
    // ok() envelope: top-level { events, metadata }
    expect(parsed.events).toHaveLength(sampleEvents.length);
    expect(parsed.events[0]).toEqual(sampleEvents[0]);
    expect(parsed.metadata).toBeDefined();
    expect(parsed.metadata.requestId).toBe('sessions-test-req');
  });

  it('returns 404 when session is not owned by the actor (owner check rejection)', async () => {
    mockGetSessionsRepository.mockReturnValue({
      isConfigured: () => true,
      getSession: jest.fn(async () => null), // not found → 404
    } as unknown as ReturnType<typeof getSessionsRepository>);

    const { status, body } = await httpGet(port, `/sessions/${TEST_SESSION_ID}/events`, {
      'Accept-Encoding': 'gzip',
    });
    expect(status).toBe(404);
    // Error body must be small plain JSON, no gzip
    const parsed = JSON.parse(body.toString('utf-8')) as { error: string };
    expect(parsed.error).toBeDefined();
    expect(body.length).toBeLessThan(2048);
  });

  it('returns identity JSON when repo is not configured (no DynamoDB)', async () => {
    // When isConfigured() returns false, ownership check is skipped
    mockGetSessionsRepository.mockReturnValue({
      isConfigured: () => false,
      getSession: jest.fn(),
    } as unknown as ReturnType<typeof getSessionsRepository>);

    mockCreateMemoryService.mockResolvedValue({
      getSessionEvents: jest.fn(async () => sampleEvents),
    } as unknown as Awaited<ReturnType<typeof createAgentCoreMemoryServiceForRequest>>);

    const { status, headers, body } = await httpGet(port, `/sessions/${TEST_SESSION_ID}/events`, {
      'Accept-Encoding': 'identity',
    });
    expect(status).toBe(200);
    expect(headers['content-encoding']).toBeUndefined();
    const parsed = JSON.parse(body.toString('utf-8')) as { events: typeof sampleEvents };
    expect(parsed.events).toHaveLength(sampleEvents.length);
  });
});

// ─── 5. Synthetic 622-message fixture ────────────────────────────────────────

function buildSyntheticFixture(messageCount: number) {
  let state = 0xdeadbeef;
  function nextInt(): number {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return state >>> 0;
  }
  function nextFloat(): number {
    return nextInt() / 0xffffffff;
  }
  function highEntropyBlock(): string {
    const bytes = new Uint8Array(48);
    for (let i = 0; i < bytes.length; i++) bytes[i] = nextInt() & 0xff;
    return Buffer.from(bytes).toString('base64');
  }

  const roles = ['user', 'assistant'] as const;
  const events = [];
  for (let i = 0; i < messageCount; i++) {
    const role = roles[i % 2]!;
    const category = i % 3;
    let content: string;
    if (category === 0) {
      content = `メッセージ ${i}: ${'こんにちは世界、これは長い会話の一部です。エージェントが返答します。'.repeat(450)} ターン${i}`;
    } else if (category === 1) {
      const sentences = [
        `Turn ${i}: The user asked about topic ${i % 47} with urgency level ${Math.floor(nextFloat() * 5)}.`,
        `Agent response ${i}: Analyzing request for item-${i % 113}. Confidence: ${(0.7 + nextFloat() * 0.3).toFixed(4)}.`,
        `Tool call ${i}: fetch_data(id="${i}-${(nextInt() % 9999).toString(16)}", region="ap-northeast-1", retries=${i % 3}).`,
        `Observation ${i}: Retrieved ${nextInt() % 1000} records from index ${i % 7}. Processing with algorithm v${(i % 4) + 1}.`,
      ];
      content = sentences.join(' ').repeat(15);
    } else {
      const blocks = Array.from({ length: 100 }, () => highEntropyBlock());
      content = JSON.stringify({
        tool: 'binary_output',
        index: i,
        data: blocks,
        checksum: nextInt().toString(16),
      });
    }
    events.push({
      eventId: `evt-${i.toString().padStart(6, '0')}`,
      role,
      content,
      createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(),
      metadata: {
        tokens: nextInt() % 2000,
        model: `model-v${(i % 4) + 1}`,
        latencyMs: nextInt() % 5000,
      },
    });
  }
  return { events };
}

describe('Synthetic 622-message fixture – compression metrics and round-trip', () => {
  let fixture: ReturnType<typeof buildSyntheticFixture>;
  let jsonBuf: Buffer;

  beforeAll(() => {
    fixture = buildSyntheticFixture(622);
    jsonBuf = Buffer.from(JSON.stringify(fixture), 'utf-8');
  });

  it('fixture has exactly 622 messages', () => {
    expect(fixture.events).toHaveLength(622);
  });

  it('original serialised JSON is >= 10 MiB', () => {
    console.log(`[fixture] original: ${(jsonBuf.length / 1024 / 1024).toFixed(2)} MiB`);
    expect(jsonBuf.length).toBeGreaterThanOrEqual(10 * 1024 * 1024);
  });

  it('gzip-compressed bytes + realistic envelope fit within Lambda 6 MiB limit', async () => {
    const compressed = (await gzipAsync(jsonBuf)) as Buffer;
    const base64Len = Math.ceil(compressed.length / 3) * 4;
    // Conservative envelope: actual measured headers ≈ 500 bytes + margins = ~1200 bytes
    // Use the same formula as the middleware: base64 + 720 (80+128+512)
    const envelopeEstimate = base64Len + 720;

    console.log(
      [
        `[fixture] original:   ${jsonBuf.length.toLocaleString()} bytes`,
        `[fixture] gzip:       ${compressed.length.toLocaleString()} bytes`,
        `[fixture] base64:     ${base64Len.toLocaleString()} bytes`,
        `[fixture] envelope:   ${envelopeEstimate.toLocaleString()} bytes`,
        `[fixture] limit:      ${(6 * 1024 * 1024).toLocaleString()} bytes`,
        `[fixture] ratio:      ${(jsonBuf.length / compressed.length).toFixed(1)}x`,
      ].join('\n')
    );

    expect(compressed.length).toBeLessThan(6 * 1024 * 1024);
    expect(envelopeEstimate).toBeLessThan(6 * 1024 * 1024);
  });

  it('round-trip: gzip → base64 → decode → gunzip → JSON.parse equals original', async () => {
    const compressed = (await gzipAsync(jsonBuf)) as Buffer;
    const b64 = compressed.toString('base64');
    const decoded = Buffer.from(b64, 'base64');
    const decompressed = await gunzipBuffer(decoded);
    const parsed = JSON.parse(decompressed.toString('utf-8')) as typeof fixture;
    expect(parsed.events).toHaveLength(622);
    expect(parsed.events[0]).toEqual(fixture.events[0]);
    expect(parsed.events[621]).toEqual(fixture.events[621]);
    expect(parsed.events[2]!.content).toBe(fixture.events[2]!.content);
  });

  it('end-to-end through real Express: 622-message fixture compresses and round-trips', async () => {
    const { listen } = buildTestApp(fixture);
    const { server, port } = await listen();
    try {
      const { status, headers, body } = await httpGet(port, '/sessions/s622/events', {
        'Accept-Encoding': 'gzip',
      });
      expect(status).toBe(200);
      expect(headers['content-encoding']).toBe('gzip');
      const decompressed = await gunzipBuffer(body);
      const parsed = JSON.parse(decompressed.toString('utf-8')) as typeof fixture;
      expect(parsed.events).toHaveLength(622);
      expect(parsed.events[0]).toEqual(fixture.events[0]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('Pool C high-entropy messages compress < 3x original (verify fixture diversity)', async () => {
    const poolCEvents = fixture.events.filter((_, i) => i % 3 === 2);
    const buf = Buffer.from(poolCEvents[0]!.content, 'utf-8');
    const compressed = (await gzipAsync(buf)) as Buffer;
    const ratio = buf.length / compressed.length;
    console.log(`[fixture] Pool C compression ratio: ${ratio.toFixed(2)}x`);
    expect(ratio).toBeLessThan(3.0);
  });
});

// ─── 6. Boundary regression: double-JSON escape ───────────────────────────────

describe('identity path – double-JSON escape boundary regression', () => {
  it('double-JSON length is larger than raw JSON when body contains many quotes', () => {
    // A body with many quotes (e.g. JSON-encoded tool output stored as a string)
    // will see significant inflation in the Lambda proxy body field.
    const quoteHeavy = { data: '"'.repeat(10000) };
    const jsonStr = JSON.stringify(quoteHeavy);
    const rawLen = Buffer.byteLength(jsonStr);
    // Each " in the value becomes \" in the outer JSON (adds 1 byte per quote)
    const doubleJsonLen = Buffer.byteLength(JSON.stringify(jsonStr));
    expect(doubleJsonLen).toBeGreaterThan(rawLen);
    // Should be approximately rawLen + 10000 escape bytes + 2 (outer quotes)
    expect(doubleJsonLen).toBeGreaterThanOrEqual(rawLen + 10000);
  });

  it('double-JSON length is larger than raw JSON length for body with quotes in values', () => {
    // JSON keys and string values contain `"` characters. Each `"` in the
    // JSON string becomes `\"` in the outer JSON-stringified value, adding 1 byte per quote.
    const plain = { events: [{ id: 1, text: 'hello world' }] };
    const jsonStr = JSON.stringify(plain);
    const rawLen = Buffer.byteLength(jsonStr);
    const doubleJsonLen = Buffer.byteLength(JSON.stringify(jsonStr));
    // Every `"` in jsonStr (keys + string values) adds an extra byte in the outer encoding,
    // plus 2 bytes for the outer wrapping quotes.
    const quoteCount = (jsonStr.match(/"/g) ?? []).length;
    expect(doubleJsonLen).toBe(rawLen + quoteCount + 2);
    expect(doubleJsonLen).toBeGreaterThan(rawLen);
  });

  it('Express app returns 413 for identity path when double-JSON would exceed 6 MiB', async () => {
    // Craft a body whose raw JSON is under 6 MiB but whose double-JSON + envelope
    // would exceed 6 MiB.  Fill value with 3 MiB of quotes (each becomes \" = 2 bytes).
    // raw JSON: ~3 MiB + wrapper → double-JSON: ~6 MiB + wrapper → over limit.
    //
    // We need double-JSON + measureEnvelopeOverhead >= 6 MiB.
    // measureEnvelopeOverhead ≈ 800 bytes (few CORS headers + margins).
    // 6 MiB - 800 = 6290656 bytes needed in double-JSON.
    // With all-quote string: doubleJsonLen ≈ rawLen + quoteCount + 2
    // rawLen ≈ quoteCount + overhead. To push doubleJsonLen to ~6.3 MiB,
    // use 3.1 MiB of quotes (each quote adds 1 byte escape in double-JSON).
    const quoteCount = 3.1 * 1024 * 1024;
    const oversizedBody = { data: '"'.repeat(Math.floor(quoteCount)) };

    const { listen } = buildTestApp(oversizedBody, 200);
    const { server, port: p } = await listen();
    try {
      const { status, body } = await httpGet(p, '/sessions/s/events', {
        'Accept-Encoding': 'identity',
      });
      expect(status).toBe(413);
      const parsed = JSON.parse(body.toString('utf-8')) as {
        code: string;
        details: { doubleJsonBytes: number };
      };
      expect(parsed.code).toBe('PAYLOAD_TOO_LARGE');
      // Response includes doubleJsonBytes so caller can diagnose
      expect(parsed.details.doubleJsonBytes).toBeGreaterThan(6 * 1024 * 1024);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
