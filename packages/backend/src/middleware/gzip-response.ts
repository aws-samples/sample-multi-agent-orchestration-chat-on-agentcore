/**
 * gzip-response middleware – scoped to GET /sessions/:sessionId/events.
 *
 * # Why this middleware exists
 * The backend runs inside AWS Lambda (via Lambda Web Adapter v1.0.0, BUFFERED mode).
 * Lambda synchronous-response payloads are hard-capped at 6 MiB.  A long
 * conversation session can produce a JSON body that exceeds that limit, causing
 * Lambda to return a truncated / errored response before the response even leaves
 * the Lambda runtime boundary.  API Gateway–level compression alone cannot solve
 * this because it is applied *after* Lambda returns the payload, so the 6 MiB
 * cap is already hit inside the runtime.
 *
 * # How it works (LWA BUFFERED mode binary encoding)
 * LWA BUFFERED mode (v1.0.0, lambda_http 1.1.1) inspects response headers after
 * Express writes them.  The relevant logic in
 * https://docs.rs/crate/lambda_http/1.1.1/source/src/response.rs (line 322) is:
 *
 *   if headers.get(CONTENT_ENCODING).is_some() { return convert_to_binary(self); }
 *
 * Setting `Content-Encoding: gzip` is therefore sufficient — LWA will call
 * `convert_to_binary`, set `isBase64Encoded: true`, and base64-encode the body
 * in the Lambda proxy response JSON regardless of the body bytes themselves.
 * Source: https://docs.rs/crate/lambda_http/1.1.1/source/src/response.rs
 *         LWA v1.0.0 Cargo.lock (lambda_http 1.1.1)
 *
 * API Gateway v2 (payload format 2.0, used here – see BackendApiConstruct) sees
 * `isBase64Encoded: true`, base64-decodes the body back to the original gzip
 * bytes, and forwards them with the `Content-Encoding: gzip` header to the
 * client.  Browsers and `fetch()` decompress transparently; the existing JSON
 * contract of `getSessionEvents` is preserved with no frontend changes.
 *
 * # Lambda payload size accounting
 *
 * The full Lambda proxy response is JSON with this shape:
 *   {"statusCode":NNN,"headers":{<headers>},"body":"<body>","isBase64Encoded":true}
 *
 * For the gzip path the body field is the base64 string of the compressed bytes:
 *   base64_len = ⌈compressed_bytes / 3⌉ × 4
 *
 * For the identity path the body field is the JSON-stringified response body –
 * i.e. the body value is already a JSON string, and when it appears inside the
 * outer proxy JSON object it is JSON-escaped a second time:
 *   identity_body_field_len = Buffer.byteLength(JSON.stringify(jsonStr))
 *
 * In both cases we measure the actual serialised response headers via
 * `res.getHeaders()` and add fixed margins for headers we have not yet set and
 * for API Gateway–injected headers (x-amzn-requestid, x-amzn-trace-id, etc.).
 * The total must be < LAMBDA_PAYLOAD_HARD_LIMIT; a 413 is returned otherwise.
 *
 * # Accept-Encoding negotiation (RFC 7231 §5.3.4)
 *   gzip (q>0) preferred over identity → compressed response
 *   identity only (gzip q=0) → plain JSON, size-checked
 *   identity;q=0 → encoding explicitly refused
 *   gzip (q>0) + identity;q=0 → MUST compress even bodies below MIN_COMPRESS_BYTES
 *   *;q=0 without explicit identity → null (406)
 *   mixed case (GZip, GZIP) → normalised to lower-case before matching
 *   q > 1 or NaN → treated as q=0 (refused) per RFC
 *
 * # Re-entry guard
 * `res.json` is restored to the original binding *before* any secondary call
 * (error body send), so 413/406 error-body calls never re-enter this middleware.
 */

import { promisify } from 'util';
import { gzip } from 'zlib';
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const gzipAsync = promisify(gzip);

// ─── Lambda payload size constants ──────────────────────────────────────────

/** AWS Lambda synchronous response hard limit (bytes). */
const LAMBDA_PAYLOAD_HARD_LIMIT = 6 * 1024 * 1024; // 6 MiB

/** Do not bother compressing bodies smaller than this (saves CPU for tiny responses). */
const MIN_COMPRESS_BYTES = 2048;

// ─── Envelope overhead measurement ──────────────────────────────────────────

/**
 * Measure the Lambda proxy JSON envelope overhead based on the current
 * response headers.
 *
 * We serialise the headers already on `res` and add:
 *   WRAPPER_BYTES  – fixed JSON structure: {"statusCode":NNN,"headers":{},
 *                    "body":"","isBase64Encoded":true} ≈ 80 bytes
 *   OWN_HEADERS    – headers we add after this call
 *                    (Content-Encoding, Content-Length, Vary, Content-Type)
 *   APIGW_HEADERS  – API Gateway–injected headers (x-amzn-requestid,
 *                    x-amzn-trace-id, apigw-requestid, etc.) ≈ 300–400 bytes;
 *                    512 gives comfortable room.
 *
 * NOTE: This does NOT account for the body itself.  The caller adds
 * `base64Length(compressed)` or `Buffer.byteLength(JSON.stringify(jsonStr))`
 * to arrive at the full envelope estimate.
 */
function measureEnvelopeOverhead(res: Response): number {
  const WRAPPER_BYTES = 80;
  const OWN_HEADERS = 128;
  const APIGW_HEADERS = 512;
  return (
    Buffer.byteLength(JSON.stringify(res.getHeaders())) +
    WRAPPER_BYTES +
    OWN_HEADERS +
    APIGW_HEADERS
  );
}

/**
 * Calculate the base64-encoded byte length for a given binary buffer.
 * base64 output length = ceil(input / 3) * 4
 */
function base64Length(byteCount: number): number {
  return Math.ceil(byteCount / 3) * 4;
}

// ─── Accept-Encoding negotiation ────────────────────────────────────────────

/**
 * Parsed encoding preference entry from an Accept-Encoding header field value.
 */
interface EncodingPreference {
  encoding: string; // lower-cased token
  q: number; // quality value [0, 1]; out-of-range values are clamped to 0
}

/**
 * Parse an Accept-Encoding header value into a list of preferences.
 *
 * Per RFC 7231 §5.3.1 the weight MUST be in the range [0, 1].  Any q value
 * outside that range or that cannot be parsed as a number is treated as q=0
 * (refused) to avoid accidentally accepting an encoding the client did not
 * intend.
 *
 * Returns an empty array for absent or empty headers.
 */
function parseAcceptEncoding(header: string | undefined): EncodingPreference[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const segments = part.trim().split(';');
      const encoding = (segments[0] ?? '').trim().toLowerCase();
      let q = 1.0;
      let qSeen = false;
      for (const seg of segments.slice(1)) {
        const trimmed = seg.trim();
        // Detect any q= parameter (case-insensitive, optional whitespace).
        if (!/^q\s*=/i.test(trimmed)) continue;
        // Duplicate q= in the same token → refuse conservatively.
        if (qSeen) {
          q = 0;
          break;
        }
        qSeen = true;
        // RFC 7231 §5.3.1: weight = 1*3DIGIT [ "." 1*3DIGIT ]
        // Only digits and a single decimal point, value in [0, 1].
        // Anything else (letters, negative sign, "NaN", extra dots) → q=0.
        const m = trimmed.match(/^q\s*=\s*(0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/i);
        if (!m) {
          q = 0;
        } else {
          const parsed = parseFloat(m[1]!);
          q = isNaN(parsed) || parsed > 1.0 || parsed < 0 ? 0 : parsed;
        }
      }
      return { encoding, q };
    })
    .filter((e) => e.encoding.length > 0);
}

/**
 * Return the preferred response encoding based on the Accept-Encoding header.
 *
 * Returns:
 *   'gzip'     – client accepts gzip (preferred over identity when q > 0)
 *   'identity' – client accepts only identity (no gzip, or gzip q=0)
 *   null       – client explicitly refuses all encodings (406 territory)
 *
 * Per RFC 7231 §5.3.4:
 *   • '*' matches any encoding not explicitly listed.
 *   • 'identity' has an implicit q=1 when absent; it is NOT subject to '*'
 *     unless explicitly listed.  The RFC note says "The 'identity' content-
 *     coding is always acceptable, unless specifically refused because the
 *     Accept-Encoding field includes 'identity;q=0' or because the field
 *     includes '*;q=0' without a separate identity field that is not zero."
 *     We follow the stricter reading: '*;q=0' DOES exclude identity unless
 *     identity is explicitly present with q>0.
 */
export function negotiateEncoding(
  acceptEncoding: string | string[] | undefined
): 'gzip' | 'identity' | null {
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(', ') : acceptEncoding;

  if (!header || header.trim() === '') return 'identity';

  const prefs = parseAcceptEncoding(header);

  const wildcard = prefs.find((e) => e.encoding === '*');
  const gzipPref = prefs.find((e) => e.encoding === 'gzip');
  const identityPref = prefs.find((e) => e.encoding === 'identity');

  // gzip quality: explicit entry wins; else fall back to wildcard; else 0 (not listed, no wildcard)
  const gzipQ = gzipPref !== undefined ? gzipPref.q : (wildcard?.q ?? 0);

  // identity quality: explicit entry wins; else 1 UNLESS wildcard is present (see RFC note above).
  const identityQ =
    identityPref !== undefined ? identityPref.q : wildcard !== undefined ? wildcard.q : 1.0;

  if (gzipQ > 0 && gzipQ >= identityQ) return 'gzip';
  if (identityQ > 0) return 'identity';
  return null;
}

/**
 * Return true when the client has explicitly refused identity encoding.
 *
 * Used to decide whether to compress bodies that would otherwise be below the
 * MIN_COMPRESS_BYTES threshold: if identity is forbidden we MUST compress
 * regardless of body size to honour the client's Accept-Encoding directive.
 */
function isIdentityForbidden(acceptEncoding: string | string[] | undefined): boolean {
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(', ') : acceptEncoding;
  if (!header || header.trim() === '') return false;
  const prefs = parseAcceptEncoding(header);
  const identityPref = prefs.find((e) => e.encoding === 'identity');
  const wildcard = prefs.find((e) => e.encoding === '*');
  const identityQ =
    identityPref !== undefined ? identityPref.q : wildcard !== undefined ? wildcard.q : 1.0;
  return identityQ <= 0;
}

// ─── Middleware ──────────────────────────────────────────────────────────────

/**
 * Express middleware that gzip-compresses `res.json()` responses for the
 * session-history endpoint, keeping the full Lambda proxy payload within the
 * 6 MiB AWS hard limit.
 *
 * Apply this middleware directly on the route that returns large JSON bodies:
 *
 *   router.get('/:sessionId/events', sessionHistoryGzipMiddleware, asyncHandler(...));
 *
 * Behaviour summary:
 *   ┌──────────────────────────────────────────────────────────────────────────────┐
 *   │ Accept-Encoding               │ body size      │ Result                     │
 *   ├──────────────────────────────────────────────────────────────────────────────┤
 *   │ gzip (q>0), identity allowed  │ < threshold    │ identity JSON (saves CPU)  │
 *   │ gzip (q>0), identity allowed  │ ≥ threshold    │ compressed; 413 if too big │
 *   │ gzip (q>0), identity;q=0      │ any size       │ compressed; 413 if too big │
 *   │ identity only (gzip q=0)      │ ≤ safe limit   │ identity JSON              │
 *   │ identity only (gzip q=0)      │ > safe limit   │ 413 small error            │
 *   │ null (all refused)            │ any            │ 406 small error            │
 *   └──────────────────────────────────────────────────────────────────────────────┘
 */
export function sessionHistoryGzipMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const encoding = negotiateEncoding(req.headers['accept-encoding']);

  // Capture the original res.json before we shadow it.
  const originalJson = res.json.bind(res) as (body: unknown) => Response;

  // Override res.json for this response only.
  res.json = (body: unknown): Response => {
    // Restore immediately so any secondary res.json call (e.g. 413 error body)
    // goes through the original without re-entering this closure.
    res.json = originalJson;

    void handleGzip(req, res, body, encoding, originalJson, next);
    return res;
  };

  next();
}

/**
 * Core async handler – separated from the middleware to keep the synchronous
 * override readable and allow async/await without Promise-in-void suppression.
 */
async function handleGzip(
  req: Request,
  res: Response,
  body: unknown,
  encoding: 'gzip' | 'identity' | null,
  originalJson: (body: unknown) => Response,
  next: NextFunction
): Promise<void> {
  try {
    // Always set Vary: Accept-Encoding so caches key on the encoding.
    // res.vary() merges with any existing Vary value (e.g. Vary: Origin set by
    // CORS middleware) rather than replacing it.
    res.vary('Accept-Encoding');

    if (encoding === null) {
      // Client explicitly refused all encodings – 406.
      // Error bodies are always sent as plain JSON; RFC allows servers to
      // override Accept-Encoding for error responses.
      res.status(406).json({
        error: 'Not Acceptable',
        message:
          'No acceptable content encoding available; omit Accept-Encoding or include gzip or identity',
        code: 'NOT_ACCEPTABLE',
        requestId: (req as unknown as AuthenticatedRequest).requestId,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const jsonStr = JSON.stringify(body);
    const jsonBuf = Buffer.from(jsonStr, 'utf-8');

    // Compress when:
    //   a) client accepts gzip AND body meets the size threshold, OR
    //   b) client accepts gzip AND identity is explicitly forbidden (must not
    //      fall back to plain JSON regardless of body size)
    const identityForbidden =
      encoding === 'gzip' && isIdentityForbidden(req.headers['accept-encoding']);
    const shouldCompress =
      encoding === 'gzip' && (jsonBuf.length >= MIN_COMPRESS_BYTES || identityForbidden);

    if (shouldCompress) {
      // ── Compressed path ──────────────────────────────────────────────────
      let compressed: Buffer;
      try {
        compressed = await gzipAsync(jsonBuf);
      } catch (err) {
        next(err);
        return;
      }

      // Measure actual envelope size: base64(compressed) + dynamic header overhead.
      const b64Len = base64Length(compressed.length);
      const envelopeSize = b64Len + measureEnvelopeOverhead(res);

      if (envelopeSize >= LAMBDA_PAYLOAD_HARD_LIMIT) {
        // Even after compression the full Lambda proxy payload would exceed 6 MiB.
        res.status(413).json({
          error: 'Payload Too Large',
          message:
            'Session history is too large to return in a single response even after gzip compression. ' +
            'Consider archiving older sessions.',
          code: 'PAYLOAD_TOO_LARGE',
          requestId: (req as unknown as AuthenticatedRequest).requestId,
          timestamp: new Date().toISOString(),
          details: {
            compressedBytes: compressed.length,
            base64Bytes: b64Len,
            estimatedEnvelopeBytes: envelopeSize,
            limitBytes: LAMBDA_PAYLOAD_HARD_LIMIT,
          },
        });
        return;
      }

      // Size check passed – send the gzip-compressed body.
      //
      // LWA BUFFERED mode (v1.0.0, lambda_http 1.1.1) checks for the presence
      // of the Content-Encoding response header (response.rs:322):
      //   if headers.get(CONTENT_ENCODING).is_some() { return convert_to_binary(self); }
      // Setting Content-Encoding: gzip is therefore sufficient for LWA to set
      // isBase64Encoded=true and base64-encode the body in the Lambda proxy
      // response JSON.  API Gateway v2 (payload format 2.0) then decodes the
      // base64 body before forwarding gzip bytes to the client.
      // Source: https://docs.rs/crate/lambda_http/1.1.1/source/src/response.rs
      //         LWA v1.0.0 Cargo.lock (lambda_http 1.1.1)
      //
      // NOTE: This LWA path is NOT verified by live Lambda invocation in this
      // test suite.  The local integration tests confirm correct gzip bytes,
      // headers, and round-trip JSON equality through a real Express/Node.js
      // HTTP server.  The LWA base64 step is verified by a separate simulation
      // test (see gzip-response.test.ts §3b).
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Length', String(compressed.length));
      res.status(res.statusCode || 200);
      res.end(compressed);
      return;
    }

    // ── Identity path (uncompressed) ─────────────────────────────────────
    // Check the double-JSON-escaped size: the Lambda proxy body field holds
    // JSON.stringify(jsonStr), not the raw UTF-8 bytes, so backslashes and
    // quotes in jsonStr inflate the body field length.
    const doubleJsonLen = Buffer.byteLength(JSON.stringify(jsonStr));
    const identityEnvelopeSize = doubleJsonLen + measureEnvelopeOverhead(res);

    if (identityEnvelopeSize >= LAMBDA_PAYLOAD_HARD_LIMIT) {
      res.removeHeader('Content-Encoding'); // remove any stale header
      res.status(413).json({
        error: 'Payload Too Large',
        message:
          'Session history is too large to return without compression and gzip was not accepted. ' +
          'Include "Accept-Encoding: gzip" in your request, or consider archiving older sessions.',
        code: 'PAYLOAD_TOO_LARGE',
        requestId: (req as unknown as AuthenticatedRequest).requestId,
        timestamp: new Date().toISOString(),
        details: {
          uncompressedBytes: jsonBuf.length,
          doubleJsonBytes: doubleJsonLen,
          estimatedEnvelopeBytes: identityEnvelopeSize,
          limitBytes: LAMBDA_PAYLOAD_HARD_LIMIT,
        },
      });
      return;
    }

    // Small or identity-only response – use standard Express JSON sending to
    // preserve Content-Type charset, ETag generation, etc.
    res.removeHeader('Content-Encoding'); // remove any stale header defensively
    originalJson(body);
  } catch (err) {
    next(err);
  }
}
