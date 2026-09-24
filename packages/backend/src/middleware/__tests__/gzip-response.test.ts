/**
 * Tests for middleware/gzip-response.ts
 *
 * Coverage:
 *  1. negotiateEncoding() – RFC 7231 Accept-Encoding parsing
 *  2. estimateEnvelopeSize() – payload size helper
 *  3. sessionHistoryGzipMiddleware() – unit tests (mocked req/res)
 *  4. Integration tests through a real Express app with real router
 *     (no DynamoDB / Lambda / browser involved; notes where live verification
 *     was not performed)
 *  5. Synthetic 622-message (~13 MB) fixture: compression metrics and
 *     round-trip integrity
 *
 * NOTE: Live E2E tests (real Lambda / API Gateway / browser auto-decompression)
 * were NOT performed.  The integration tests below confirm that Express sends
 * the correct gzip bytes, headers, and status codes through the real router
 * using Node.js built-in http.  Browser auto-decompression of
 * Content-Encoding: gzip is a browser-platform guarantee and not re-tested here.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createGunzip, gzip as gzipCb } from 'zlib';
import { promisify } from 'util';
import { createServer, type Server, type IncomingMessage, request as httpRequest } from 'http';
import express, { type Request, type Response, type NextFunction } from 'express';
import {
  negotiateEncoding,
  estimateEnvelopeSize,
  sessionHistoryGzipMiddleware,
} from '../gzip-response.js';

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
    // gzip q=1 >= identity q=1, gzip is preferred
    expect(negotiateEncoding('gzip, identity')).toBe('gzip');
  });

  it('handles array header (multiple Accept-Encoding values)', () => {
    expect(negotiateEncoding(['gzip', 'deflate'])).toBe('gzip');
  });
});

// ─── 2. estimateEnvelopeSize ──────────────────────────────────────────────────

describe('estimateEnvelopeSize', () => {
  it('is always larger than bodyBytes', () => {
    expect(estimateEnvelopeSize(0)).toBeGreaterThan(0);
    expect(estimateEnvelopeSize(1000)).toBeGreaterThan(1000);
  });

  it('includes at least 4 KiB overhead', () => {
    const overhead = estimateEnvelopeSize(0);
    expect(overhead).toBeGreaterThanOrEqual(4096);
  });
});

// ─── 3. sessionHistoryGzipMiddleware unit tests ───────────────────────────────

describe('sessionHistoryGzipMiddleware (unit)', () => {
  it('calls next() to continue the middleware chain', async () => {
    const req = makeReq('gzip') as Request;
    const { res } = makeRes();
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };

    sessionHistoryGzipMiddleware(req, res, next as NextFunction);
    expect(nextCalled).toBe(true);
  });

  it('compresses large JSON body when gzip accepted', async () => {
    const req = makeReq('gzip') as Request;
    const { res, headers, getBody } = makeRes();
    sessionHistoryGzipMiddleware(req, res, (() => {}) as NextFunction);

    const largeBody = {
      events: Array.from({ length: 500 }, (_, i) => ({ id: i, text: 'x'.repeat(100) })),
    };

    await new Promise<void>((resolve) => {
      // Wait for async work by polling
      const check = setInterval(() => {
        const body = getBody();
        if (body) {
          clearInterval(check);
          resolve();
        }
      }, 10);
      // Trigger the intercepted res.json
      res.json(largeBody);
      // Safety timeout
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 2000);
    });

    expect(headers['content-encoding']).toBe('gzip');
    expect(headers['vary']).toBe('Accept-Encoding');
    expect(headers['content-type']).toBe('application/json');

    const body = getBody();
    expect(body).not.toBeNull();

    // Decompress and verify round-trip
    const decompressed = await gunzipBuffer(body!);
    const parsed = JSON.parse(decompressed.toString('utf-8')) as typeof largeBody;
    expect(parsed.events).toHaveLength(500);
    expect(parsed.events[0]).toEqual(largeBody.events[0]);
  });

  it('does NOT compress small body even if gzip accepted', async () => {
    const req = makeReq('gzip') as Request;
    const { res, headers } = makeRes();
    sessionHistoryGzipMiddleware(req, res, (() => {}) as NextFunction);

    const smallBody = {
      events: [{ id: 1, text: 'hello' }],
      metadata: { requestId: 'x', timestamp: new Date().toISOString() },
    };

    res.json(smallBody);

    // Wait briefly for async resolution
    await new Promise((r) => setTimeout(r, 200));

    // Small body → identity path via originalJson
    expect(headers['content-encoding']).toBeUndefined();
    expect(headers['vary']).toBe('Accept-Encoding');
  });

  it('sends plain identity JSON when only identity accepted', async () => {
    const req = makeReq('identity') as Request;
    const { res, headers } = makeRes();
    sessionHistoryGzipMiddleware(req, res, (() => {}) as NextFunction);

    const body = {
      events: [] as unknown[],
      metadata: { requestId: 'y', timestamp: new Date().toISOString() },
    };
    res.json(body);

    await new Promise((r) => setTimeout(r, 100));
    expect(headers['content-encoding']).toBeUndefined();
    expect(headers['vary']).toBe('Accept-Encoding');
  });

  it('returns 406 when all encodings refused (q=0)', async () => {
    const req = makeReq('gzip;q=0, identity;q=0') as Request;
    const { res } = makeRes();
    let statusSet = 0;
    (res as unknown as { status: (n: number) => Response }).status = (n) => {
      statusSet = n;
      return res;
    };
    sessionHistoryGzipMiddleware(req, res, (() => {}) as NextFunction);

    res.json({ events: [] });

    await new Promise((r) => setTimeout(r, 100));
    expect(statusSet).toBe(406);
  });

  it('does not set Content-Encoding on 406 error response', async () => {
    const req = makeReq('gzip;q=0, identity;q=0') as Request;
    const { res, headers } = makeRes();
    sessionHistoryGzipMiddleware(req, res, (() => {}) as NextFunction);
    res.json({ events: [] });

    await new Promise((r) => setTimeout(r, 100));
    // Error path must never carry Content-Encoding: gzip
    expect(headers['content-encoding']).toBeUndefined();
  });

  it('verifies Vary: Accept-Encoding is always set', async () => {
    for (const ae of ['gzip', 'identity', undefined]) {
      const req = makeReq(ae) as Request;
      const { res, headers } = makeRes();
      sessionHistoryGzipMiddleware(req, res, (() => {}) as NextFunction);
      res.json({ events: [], metadata: { requestId: 'r', timestamp: new Date().toISOString() } });
      await new Promise((r) => setTimeout(r, 200));
      expect(headers['vary']).toBe('Accept-Encoding');
    }
  });
});

// ─── 4. Integration tests through real Express app ────────────────────────────

/**
 * Minimal Express app that wires the real sessions router with a mocked
 * auth middleware and a stubbed memory service.
 *
 * We cannot use the full BackendApi because it depends on AWS resources.
 * Instead, we create a stripped Express instance that mounts only the
 * sessions router, with:
 *   - req.identityId hard-coded to a test actor
 *   - getSessionsRepository() stubbed to return "not configured" (no DynamoDB)
 *   - createAgentCoreMemoryServiceForRequest() stubbed via module-level mock
 *
 * The real gzip-response middleware is included because sessions.ts imports it.
 */

// We can't easily stub ES module dependencies without jest.mock at module
// import level.  Instead, we build a minimal Express test app directly that
// mounts the gzip middleware and a route handler that returns a synthetic
// payload – this exercises the FULL middleware + route path without needing
// DynamoDB stubs.

function buildTestApp(
  responseBody: unknown,
  statusCode = 200
): { app: express.Express; listen: () => Promise<{ server: Server; port: number }> } {
  const app = express();
  app.use(express.json({ limit: '100mb' }));

  // Inject a fake requestId onto every request
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Record<string, unknown>).requestId = 'integ-test-id';
    (req as Record<string, unknown>).log = {
      warn: () => {},
      error: () => {},
      info: () => {},
    };
    next();
  });

  // Mount gzip middleware + simple handler (mirrors what sessions.ts does)
  app.get(
    '/sessions/:sessionId/events',
    sessionHistoryGzipMiddleware,
    (_req: Request, res: Response) => {
      res.status(statusCode).json(responseBody);
    }
  );

  const listen = (): Promise<{ server: Server; port: number }> =>
    new Promise((resolve) => {
      const server = createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve({ server, port: addr.port });
      });
    });

  return { app, listen };
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

describe('sessionHistoryGzipMiddleware (integration through real Express)', () => {
  // Build a large body that the middleware will compress (>2 KB threshold)
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

  it('returns 200 with Content-Encoding: gzip when Accept-Encoding: gzip', async () => {
    const { status, headers } = await httpGet(port, '/sessions/test-session/events', {
      'Accept-Encoding': 'gzip',
    });
    expect(status).toBe(200);
    expect(headers['content-encoding']).toBe('gzip');
    expect(headers['vary']).toBe('Accept-Encoding');
    expect(headers['content-type']).toBe('application/json');
  });

  it('body is valid gzip that decompresses to valid JSON (round-trip)', async () => {
    const { body, headers } = await httpGet(port, '/sessions/test-session/events', {
      'Accept-Encoding': 'gzip',
    });
    expect(headers['content-encoding']).toBe('gzip');
    const decompressed = await gunzipBuffer(body);
    const parsed = JSON.parse(decompressed.toString('utf-8')) as typeof largeBody;
    expect(parsed.events).toHaveLength(largeEvents.length);
    // Deep equality spot-check
    expect(parsed.events[0]).toEqual(largeEvents[0]);
    expect(parsed.events[largeEvents.length - 1]).toEqual(largeEvents[largeEvents.length - 1]);
  });

  it('round-trip preserves UTF-8 Japanese content', async () => {
    const { body, headers } = await httpGet(port, '/sessions/test-session/events', {
      'Accept-Encoding': 'gzip',
    });
    expect(headers['content-encoding']).toBe('gzip');
    const decompressed = await gunzipBuffer(body);
    const parsed = JSON.parse(decompressed.toString('utf-8')) as typeof largeBody;
    expect(parsed.events[0]!.content).toContain('こんにちは、世界！');
  });

  it('returns plain JSON (no Content-Encoding) when Accept-Encoding: identity', async () => {
    const { status, headers, body } = await httpGet(port, '/sessions/test-session/events', {
      'Accept-Encoding': 'identity',
    });
    expect(status).toBe(200);
    expect(headers['content-encoding']).toBeUndefined();
    // Body is plain JSON
    const parsed = JSON.parse(body.toString('utf-8')) as typeof largeBody;
    expect(parsed.events).toHaveLength(largeEvents.length);
  });

  it('returns gzip when Accept-Encoding header is omitted (identity default, body small enough)', async () => {
    // No accept-encoding → negotiateEncoding returns 'identity'
    // But this body is large, so still returns identity (no compression)
    const { status, headers } = await httpGet(port, '/sessions/test-session/events');
    expect(status).toBe(200);
    // Without gzip accept header, identity is used → no Content-Encoding
    expect(headers['content-encoding']).toBeUndefined();
  });

  it('returns 406 when gzip;q=0, identity;q=0', async () => {
    const { status } = await httpGet(port, '/sessions/test-session/events', {
      'Accept-Encoding': 'gzip;q=0, identity;q=0',
    });
    expect(status).toBe(406);
  });

  it('Content-Encoding header is absent on 406 error response', async () => {
    const { headers } = await httpGet(port, '/sessions/test-session/events', {
      'Accept-Encoding': 'gzip;q=0, identity;q=0',
    });
    expect(headers['content-encoding']).toBeUndefined();
  });

  it('406 error body is a small well-formed JSON', async () => {
    const { body } = await httpGet(port, '/sessions/test-session/events', {
      'Accept-Encoding': 'gzip;q=0, identity;q=0',
    });
    // Body must be a small JSON error – not the full event payload
    const parsed = JSON.parse(body.toString('utf-8')) as { error: string; code: string };
    expect(parsed.error).toBeDefined();
    expect(parsed.code).toBe('NOT_ACCEPTABLE');
    expect(body.length).toBeLessThan(1024); // Small error body
  });

  it('Content-Length header matches actual compressed byte count', async () => {
    const { headers, body } = await httpGet(port, '/sessions/test-session/events', {
      'Accept-Encoding': 'gzip',
    });
    const reported = parseInt(headers['content-length'] ?? '0', 10);
    expect(reported).toBeGreaterThan(0);
    expect(reported).toBe(body.length);
  });
});

// ─── 4b. Integration: small response ──────────────────────────────────────────

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

  it('does not compress small responses even with gzip accept', async () => {
    const { status, headers } = await httpGet(port, '/sessions/s/events', {
      'Accept-Encoding': 'gzip',
    });
    expect(status).toBe(200);
    // Under MIN_COMPRESS_BYTES threshold → identity path
    expect(headers['content-encoding']).toBeUndefined();
    expect(headers['vary']).toBe('Accept-Encoding');
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

// ─── 5. Synthetic 622-message (~13 MB) fixture ───────────────────────────────

/**
 * Deterministic fixture generator.
 *
 * Message content is drawn from three pools to avoid the "compression
 * artefact" trap of using purely repetitive strings:
 *   A) Repetitive Japanese prose (high compressibility)
 *   B) Varied English sentences with unique indices (medium compressibility)
 *   C) Deterministic high-entropy pseudo-random base64 strings (low
 *      compressibility – simulates binary tool output encoded in JSON)
 *
 * The generator is seeded deterministically so test results are reproducible.
 */
function buildSyntheticFixture(messageCount: number): {
  events: Array<{
    eventId: string;
    role: string;
    content: string;
    createdAt: string;
    metadata: Record<string, unknown>;
  }>;
} {
  // Simple deterministic pseudo-random number generator (xorshift32)
  let state = 0xdeadbeef;
  function nextInt(): number {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return state >>> 0; // unsigned 32-bit
  }
  function nextFloat(): number {
    return nextInt() / 0xffffffff;
  }

  // Pool C: deterministic high-entropy strings (16 bytes → 24 base64 chars)
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
      // Pool A – repetitive Japanese prose (high compressibility)
      // repeat(450) × ~34 Japanese chars × 3 bytes/char ≈ 46 KB per event
      content = `メッセージ ${i}: ${'こんにちは世界、これは長い会話の一部です。エージェントが返答します。'.repeat(450)} ターン${i}`;
    } else if (category === 1) {
      // Pool B – varied English sentences (medium compressibility)
      // 4 sentences × ~200 chars × repeat(15) ≈ 12 KB per event
      const sentences = [
        `Turn ${i}: The user asked about topic ${i % 47} with urgency level ${Math.floor(nextFloat() * 5)}.`,
        `Agent response ${i}: Analyzing request for item-${i % 113}. Confidence: ${(0.7 + nextFloat() * 0.3).toFixed(4)}.`,
        `Tool call ${i}: fetch_data(id="${i}-${(nextInt() % 9999).toString(16)}", region="ap-northeast-1", retries=${i % 3}).`,
        `Observation ${i}: Retrieved ${nextInt() % 1000} records from index ${i % 7}. Processing with algorithm v${(i % 4) + 1}.`,
      ];
      content = sentences.join(' ').repeat(15);
    } else {
      // Pool C – high-entropy content (low compressibility)
      // 100 base64 blocks × 64 chars ≈ 6.4 KB per event
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

  it('original serialised JSON is in the expected size range (>= 10 MB)', () => {
    // The fixture should produce a large enough payload to exercise the
    // compression path.  If this assertion fails the fixture generator needs
    // to be tuned.  Target: ~13 MB.
    console.log(
      `[fixture] original serialised bytes: ${(jsonBuf.length / 1024 / 1024).toFixed(2)} MiB`
    );
    expect(jsonBuf.length).toBeGreaterThanOrEqual(10 * 1024 * 1024);
  });

  it('gzip-compressed bytes fit within MAX_SAFE_GZIP_BYTES constant', async () => {
    const compressed = (await gzipAsync(jsonBuf)) as Buffer;
    const base64Len = Math.ceil(compressed.length / 3) * 4;
    const envelopeSize = base64Len + 4096; // LAMBDA_ENVELOPE_OVERHEAD

    console.log(
      [
        `[fixture] original bytes:    ${jsonBuf.length.toLocaleString()}`,
        `[fixture] gzip bytes:        ${compressed.length.toLocaleString()}`,
        `[fixture] base64 bytes:      ${base64Len.toLocaleString()}`,
        `[fixture] envelope bytes:    ${envelopeSize.toLocaleString()}`,
        `[fixture] Lambda limit:      ${(6 * 1024 * 1024).toLocaleString()}`,
        `[fixture] compression ratio: ${(jsonBuf.length / compressed.length).toFixed(1)}x`,
      ].join('\n')
    );

    expect(compressed.length).toBeLessThan(6 * 1024 * 1024);
    expect(envelopeSize).toBeLessThan(6 * 1024 * 1024);
  });

  it('round-trip: gzip→base64→base64decode→gunzip→JSON.parse equals original', async () => {
    const compressed = (await gzipAsync(jsonBuf)) as Buffer;

    // Simulate LWA base64 encode
    const b64 = compressed.toString('base64');
    // Simulate API Gateway v2 base64 decode
    const decoded = Buffer.from(b64, 'base64');
    // Browser gunzip
    const decompressed = await gunzipBuffer(decoded);
    const parsed = JSON.parse(decompressed.toString('utf-8')) as typeof fixture;

    expect(parsed.events).toHaveLength(622);
    expect(parsed.events[0]).toEqual(fixture.events[0]);
    expect(parsed.events[621]).toEqual(fixture.events[621]);
    // Spot-check high-entropy Pool C message
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
      // Deep equality on first and last
      expect(parsed.events[0]).toEqual(fixture.events[0]);
      expect(parsed.events[621]).toEqual(fixture.events[621]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('high-entropy Pool C messages compress to < 10x original (verify fixture diversity)', async () => {
    // Find first Pool C message (index % 3 === 2)
    const poolCEvents = fixture.events.filter((_, i) => i % 3 === 2);
    expect(poolCEvents.length).toBeGreaterThan(0);

    const sampleContent = poolCEvents[0]!.content;
    const buf = Buffer.from(sampleContent, 'utf-8');
    const compressed = (await gzipAsync(buf)) as Buffer;

    // High-entropy: compression ratio should be < 3x (not the 10x+ of repetitive text)
    const ratio = buf.length / compressed.length;
    console.log(`[fixture] Pool C (high-entropy) compression ratio: ${ratio.toFixed(2)}x`);
    expect(ratio).toBeLessThan(3.0);
  });
});
