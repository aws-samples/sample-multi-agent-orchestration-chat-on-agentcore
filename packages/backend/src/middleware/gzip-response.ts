/**
 * gzip-response middleware – scoped to GET /sessions/:sessionId/events.
 *
 * # Why this middleware exists
 * The backend runs inside AWS Lambda (via Lambda Web Adapter, BUFFERED mode).
 * Lambda synchronous-response payloads are hard-capped at 6 MB. A long
 * conversation session can produce a JSON body that exceeds that limit,
 * causing Lambda to return a truncated / errored response before the response
 * even leaves the Lambda runtime boundary.  API Gateway–level compression
 * alone cannot solve this because it is applied *after* Lambda returns the
 * payload, which means the 6 MB cap is already hit.
 *
 * By gzip-compressing the response body inside Express – before LWA packages
 * it into a Lambda proxy response object – we shrink the binary payload, then
 * LWA base64-encodes it (gzip bytes are not valid UTF-8, so LWA's UTF-8
 * round-trip check triggers base64 encoding automatically).  API Gateway v2
 * sees `isBase64Encoded: true`, base64-decodes the body back to gzip bytes,
 * and forwards them with `Content-Encoding: gzip` to the client.  Browsers
 * and `fetch()` decompress transparently.
 *
 * # Lambda payload size guarantee
 * ```
 * base64_len   = ⌈gzip_bytes / 3⌉ × 4
 * envelope     ≈ 4 KiB  (statusCode, headers, isBase64Encoded JSON overhead)
 * total        = base64_len + envelope   must be < 6 MiB
 * ```
 * MAX_SAFE_GZIP_BYTES is derived from that inequality so we always check the
 * *full serialised Lambda proxy envelope*, not just the raw gzip buffer.
 *
 * # Accept-Encoding negotiation
 * Implements RFC 7231 §5.3.4 quality-value parsing:
 *   gzip     → compressed response
 *   identity → plain JSON response (size-checked, 413 if too large)
 *   q=0      → encoding explicitly refused
 *   *        → wildcard (applies to gzip but NOT to identity per RFC note)
 *   mixed case (GZip, GZIP) → normalised to lower-case before matching
 *
 * # Re-entry guard
 * res.json is restored to the original binding *before* any send or error so
 * that 413 / 406 error-body calls never re-enter this middleware.
 */

import { promisify } from 'util';
import { gzip } from 'zlib';
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const gzipAsync = promisify(gzip);

// ─── Lambda payload size constants ──────────────────────────────────────────

/** AWS Lambda synchronous response hard limit (bytes). */
const LAMBDA_PAYLOAD_HARD_LIMIT = 6 * 1024 * 1024; // 6 MiB

/**
 * Conservative estimate for the Lambda proxy response JSON envelope overhead:
 * statusCode, isBase64Encoded flag, headers object with ~10 entries, quotes,
 * colons, commas.  4 KiB is generous; measured envelopes are typically < 1 KiB.
 */
const LAMBDA_ENVELOPE_OVERHEAD = 4096;

/**
 * Maximum gzip-compressed body size that will fit inside a Lambda response
 * after base64 encoding and envelope overhead.
 *
 * Derivation:
 *   base64_len = ceil(gzip_bytes / 3) * 4  ≤  gzip_bytes * 4/3 + 4
 *   base64_len + ENVELOPE < LIMIT
 *   gzip_bytes * 4/3  < LIMIT - ENVELOPE
 *   gzip_bytes  < (LIMIT - ENVELOPE) * 3/4
 */
const MAX_SAFE_GZIP_BYTES = Math.floor(
  (LAMBDA_PAYLOAD_HARD_LIMIT - LAMBDA_ENVELOPE_OVERHEAD) * 0.75
);

/**
 * Maximum uncompressed body size for identity (plain JSON) responses.
 * (The body itself is the Lambda payload body field, as a JSON string.)
 * JSON-stringified body adds ~2 bytes of string-escape overhead per quote,
 * but the raw UTF-8 bytes already account for any multi-byte characters.
 * We use a simple subtraction of the envelope overhead.
 */
const MAX_SAFE_IDENTITY_BYTES = LAMBDA_PAYLOAD_HARD_LIMIT - LAMBDA_ENVELOPE_OVERHEAD;

/** Do not bother compressing bodies smaller than this (saves CPU for tiny responses). */
const MIN_COMPRESS_BYTES = 2048;

// ─── Accept-Encoding negotiation ────────────────────────────────────────────

/**
 * Parsed encoding preference entry from an Accept-Encoding header field value.
 */
interface EncodingPreference {
  encoding: string; // lower-cased token
  q: number; // quality value [0, 1]
}

/**
 * Parse an Accept-Encoding header value into a list of preferences.
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
      for (const seg of segments.slice(1)) {
        const m = seg.trim().match(/^q\s*=\s*([0-9]*\.?[0-9]+)$/i);
        if (m) {
          q = parseFloat(m[1]!);
          break;
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
 *     identity is explicitly present with q>0.  This matches the common
 *     browser/fetch behaviour.
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

  // gzip quality: explicit entry wins; else fall back to wildcard; else 0 (not in list, no wildcard)
  const gzipQ = gzipPref !== undefined ? gzipPref.q : (wildcard?.q ?? 0);

  // identity quality: explicit entry wins; else 1 UNLESS wildcard explicitly present (see RFC note above).
  const identityQ =
    identityPref !== undefined ? identityPref.q : wildcard !== undefined ? wildcard.q : 1.0;

  if (gzipQ > 0 && gzipQ >= identityQ) return 'gzip';
  if (identityQ > 0) return 'identity';
  return null;
}

// ─── Payload size helpers ────────────────────────────────────────────────────

/**
 * Calculate the base64-encoded byte length for a given binary buffer.
 * base64 output length = ceil(input / 3) * 4
 */
function base64Length(byteCount: number): number {
  return Math.ceil(byteCount / 3) * 4;
}

/**
 * Estimate the full Lambda proxy envelope byte count for a given body length.
 * `bodyBytes` should already be the base64 length if the body is base64-encoded.
 */
export function estimateEnvelopeSize(bodyBytes: number): number {
  return bodyBytes + LAMBDA_ENVELOPE_OVERHEAD;
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
 * The middleware intercepts `res.json`, serialises the body to UTF-8 JSON,
 * compresses it asynchronously, checks that the base64-encoded compressed
 * bytes plus envelope overhead stay below the Lambda limit, and then sends
 * the response manually.  `res.json` is restored to its original binding
 * before any secondary send (error path) so that error-body calls are never
 * re-intercepted.
 *
 * Behaviour summary:
 *   ┌──────────────────────────────────────────────────────────────────────────┐
 *   │ Accept-Encoding │ body size      │ Result                               │
 *   ├──────────────────────────────────────────────────────────────────────────┤
 *   │ gzip (q>0)      │ < threshold    │ identity JSON (no wasted CPU)        │
 *   │ gzip (q>0)      │ ≥ threshold    │ compressed; 413 if still too large   │
 *   │ identity only   │ ≤ safe limit   │ identity JSON                        │
 *   │ identity only   │ > safe limit   │ 413 small error                      │
 *   │ null (refused)  │ any            │ 406 small error                      │
 *   └──────────────────────────────────────────────────────────────────────────┘
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
 * override readable and allow async/await without Promise-in-void suppression
 * scattered across the closure.
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
    if (encoding === null) {
      // Client explicitly refused all encodings.
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
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

    if (encoding === 'gzip' && jsonBuf.length >= MIN_COMPRESS_BYTES) {
      // ── Compressed path ──────────────────────────────────────────────────
      let compressed: Buffer;
      try {
        compressed = await gzipAsync(jsonBuf);
      } catch (err) {
        next(err);
        return;
      }

      const b64Len = base64Length(compressed.length);
      const envelopeSize = estimateEnvelopeSize(b64Len);

      if (compressed.length > MAX_SAFE_GZIP_BYTES || envelopeSize > LAMBDA_PAYLOAD_HARD_LIMIT) {
        // Even after compression the payload is too large.
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

      // All size checks passed – send the gzip-compressed body.
      // LWA (Lambda Web Adapter) will detect non-UTF-8 binary bytes and
      // automatically base64-encode the body, setting isBase64Encoded=true in
      // the Lambda proxy response.  API Gateway v2 (payload format 2.0) then
      // base64-decodes the body before forwarding to the client.
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', String(compressed.length));
      res.status(res.statusCode || 200);
      res.end(compressed);
      return;
    }

    // ── Identity path (uncompressed, or body too small to bother) ─────────
    if (jsonBuf.length > MAX_SAFE_IDENTITY_BYTES) {
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
          limitBytes: MAX_SAFE_IDENTITY_BYTES,
        },
      });
      return;
    }

    // Small or identity-only response – use standard Express JSON sending to
    // preserve Content-Type charset, ETag generation, etc.
    res.setHeader('Vary', 'Accept-Encoding');
    originalJson(body);
  } catch (err) {
    next(err);
  }
}
