import { useEffect, useState } from 'react';
import { logger } from '../../../utils/logger';

/** Text previews read at most this many bytes (Range request). */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

/** Up to this share of invalid sequences still counts as UTF-8 (stray bytes in logs). */
const UTF8_MAX_INVALID_RATIO = 0.001;

interface FileTextState {
  text: string | null;
  truncated: boolean;
  error: string | null;
}

/**
 * Decodes a file head.
 * - UTF-16 with a BOM (Excel's "Unicode Text" export) is decoded as such.
 * - UTF-8 tolerates a few invalid bytes, so one stray byte in a large log does
 *   not turn the whole preview into Shift_JIS garbage.
 * - Otherwise Shift_JIS: Japanese Excel still exports CSV in it by default.
 * `stream: true` keeps a multi-byte character cut by the byte limit from being
 * counted as invalid.
 */
export function decodeText(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes, { stream: true });
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes, { stream: true });
  }

  const utf8 = new TextDecoder('utf-8').decode(bytes, { stream: true });
  let invalid = 0;
  for (let i = utf8.indexOf('\uFFFD'); i !== -1; i = utf8.indexOf('\uFFFD', i + 1)) invalid++;
  const hasUtf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (invalid === 0 || hasUtf8Bom || invalid <= utf8.length * UTF8_MAX_INVALID_RATIO) {
    return utf8;
  }
  try {
    return new TextDecoder('shift_jis', { fatal: true }).decode(bytes, { stream: true });
  } catch {
    return utf8; // Neither encoding fits: show UTF-8 with replacement characters.
  }
}

/**
 * Reads at most `limit` bytes, then cancels the stream — a server that ignores
 * the Range header must not pull a multi-GB body into memory.
 */
async function readHead(
  res: Response,
  limit: number
): Promise<{ buf: ArrayBuffer; more: boolean }> {
  if (!res.body) {
    const all = await res.arrayBuffer();
    return { buf: all.slice(0, limit), more: all.byteLength > limit };
  }
  const reader = res.body.getReader();
  const out = new Uint8Array(limit);
  let length = 0;
  let more = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.byteLength, limit - length);
    out.set(value.subarray(0, take), length);
    length += take;
    if (take < value.byteLength || length >= limit) {
      more = take < value.byteLength || !(await reader.read()).done;
      break;
    }
  }
  await reader.cancel().catch(() => undefined);
  return { buf: out.slice(0, length).buffer, more };
}

/**
 * 206 bodies stop at the limit, so the body alone cannot tell whether more
 * exists. The total comes from `Content-Range` (`bytes 0-1048575/3145728`),
 * then the listed size; callers like the chat dock only know the path, and
 * Content-Range is unreadable cross-origin unless the bucket exposes it. With
 * neither, a full buffer counts as truncated: wrongly flagging an exactly-1 MiB
 * file beats rendering a cut-off HTML document as if it were whole.
 */
export function isRangeTruncated(
  res: Pick<Response, 'headers'>,
  received: number,
  size: number | undefined
): boolean {
  const total = Number(res.headers.get('Content-Range')?.split('/')[1]);
  if (Number.isFinite(total) && total > 0) return total > received;
  if (size !== undefined) return size > TEXT_PREVIEW_MAX_BYTES;
  return received >= TEXT_PREVIEW_MAX_BYTES;
}

/** Fetches the head of a text file from a presigned URL; pass `null` to skip. */
export function useFileText(url: string | null, size: number | undefined): FileTextState {
  const [state, setState] = useState<FileTextState & { url: string | null }>({
    url: null,
    text: null,
    truncated: false,
    error: null,
  });

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    fetch(url, {
      signal: controller.signal,
      headers: { Range: `bytes=0-${TEXT_PREVIEW_MAX_BYTES - 1}` },
    })
      .then(async (res) => {
        // S3 answers a Range request on an empty object with 416.
        if (res.status === 416) {
          setState({ url, text: '', truncated: false, error: null });
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { buf, more } = await readHead(res, TEXT_PREVIEW_MAX_BYTES);
        const truncated = res.status === 206 ? isRangeTruncated(res, buf.byteLength, size) : more;
        setState({ url, text: decodeText(buf), truncated, error: null });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        logger.error('Failed to fetch file text:', err);
        setState({
          url,
          text: null,
          truncated: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => controller.abort();
  }, [url, size]);

  return state.url === url
    ? { text: state.text, truncated: state.truncated, error: state.error }
    : { text: null, truncated: false, error: null };
}
