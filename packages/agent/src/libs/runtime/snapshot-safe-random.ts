/**
 * Snapshot-safe randomness for AgentCore Runtime platform version V2.
 *
 * V2 restores every session microVM from one memory snapshot. Node's `crypto`
 * is backed by OpenSSL, whose DRBG state (and Node's 128-entry randomUUID
 * cache) is copied into that snapshot and does not reseed after a restore, so
 * two sessions can draw identical "random" values — e.g. the AWS SDK's
 * auto-filled `clientToken` on AgentCore Memory `CreateEvent`, or Strands
 * message ids. AWS's documented workaround for Node.js is to read
 * `/dev/urandom` per call, which the kernel reseeds on restore.
 *
 * Why patch globals instead of call sites: the colliding calls live in
 * dependencies (Smithy idempotency tokens, Strands, uuid), not in our code.
 *
 * Why not pool bytes: a pool filled before the snapshot would itself be
 * duplicated, so every call reads `/dev/urandom`. The fd itself is kept open:
 * it holds no RNG state, and reads after a restore come from the reseeded kernel.
 *
 * `Math.random` is covered too: V8's PRNG state is in the snapshot, and
 * OpenTelemetry's trace/span id generator draws from it.
 *
 * TLS handshakes also draw from OpenSSL and cannot be fixed from userland.
 *
 * Not covered (and why that is acceptable today):
 * - `worker_threads` workers get a fresh, unpatched `crypto`. The only worker
 *   (view-image/fit-image.worker.ts) uses no randomness; install the patch in
 *   any new worker that does.
 * - `uuid` v7 keeps its own 256-byte pool. It is only filled inside request
 *   handling, so the pool is empty at snapshot time; calling `uuidv7()` during
 *   startup would put a duplicated pool into the snapshot.
 * - Modules preloaded by `startup.sh` (`--require` ADOT) load before this
 *   patch. They read `crypto.*` at call time today; a dependency that captured
 *   a function by value at load time would bypass the patch.
 */

import crypto from 'node:crypto';
import { openSync, readSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

type Fillable = NodeJS.ArrayBufferView | ArrayBuffer | SharedArrayBuffer;
type FillCallback<T> = (err: Error | null, buf: T) => void;

const URANDOM = '/dev/urandom';
const MAX_GET_RANDOM_VALUES_BYTES = 65536;
const RANDOM_INT_MAX_RANGE = 2 ** 48;
const INTEGER_ARRAYS = [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  BigInt64Array,
  BigUint64Array,
];

let urandomFd: number | null = null;

let originals: {
  randomBytes: typeof crypto.randomBytes;
  randomFillSync: typeof crypto.randomFillSync;
  randomFill: typeof crypto.randomFill;
  randomUUID: typeof crypto.randomUUID;
  randomInt: typeof crypto.randomInt;
  mathRandom: typeof Math.random;
  webRandomUUID: PropertyDescriptor | undefined;
  webGetRandomValues: PropertyDescriptor | undefined;
} | null = null;

/** Fill `target[offset, offset + length)` from /dev/urandom. */
export function readUrandomInto(
  target: Uint8Array,
  offset = 0,
  length = target.byteLength - offset
): void {
  urandomFd ??= openSync(URANDOM, 'r');
  let read = 0;
  while (read < length) {
    const n = readSync(urandomFd, target, offset + read, length - read, null);
    if (n === 0) throw new Error(`${URANDOM} returned EOF`);
    read += n;
  }
}

function asBytes(buf: Fillable): Uint8Array {
  if (buf instanceof ArrayBuffer || buf instanceof SharedArrayBuffer) return new Uint8Array(buf);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
  const b = new Uint8Array(16);
  readUrandomInto(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Buffer.from(b).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function randomFillSync<T extends Fillable>(buf: T, offset = 0, size?: number): T {
  const bytes = asBytes(buf);
  // Node measures offset/size in elements of a TypedArray (bytes otherwise).
  const unit = (buf as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
  const start = offset * unit;
  const length = size === undefined ? bytes.byteLength - start : size * unit;
  if (start < 0 || length < 0 || start + length > bytes.byteLength) {
    throw new RangeError('randomFillSync: offset/size out of range');
  }
  readUrandomInto(bytes, start, length);
  return buf;
}

function randomBytes(size: number): Buffer;
function randomBytes(size: number, cb: FillCallback<Buffer>): void;
function randomBytes(size: number, cb?: FillCallback<Buffer>): Buffer | void {
  if (!cb) {
    // Not allocUnsafe: a pooled Buffer's `.buffer` would expose the 8 KB shared
    // pool instead of `size` bytes, unlike Node's randomBytes.
    const out = Buffer.allocUnsafeSlow(size);
    readUrandomInto(out);
    return out;
  }
  try {
    const out = randomBytes(size);
    process.nextTick(cb, null, out);
  } catch (err) {
    process.nextTick(cb, err as Error, Buffer.alloc(0));
  }
}

function randomFill<T extends Fillable>(buf: T, ...args: unknown[]): void {
  const cb = args.pop() as FillCallback<T>;
  const [offset, size] = args as [number | undefined, number | undefined];
  try {
    randomFillSync(buf, offset, size);
    process.nextTick(cb, null, buf);
  } catch (err) {
    process.nextTick(cb, err as Error, buf);
  }
}

function getRandomValues<T extends NodeJS.ArrayBufferView | null>(array: T): T {
  if (array === null) throw new TypeError('getRandomValues: array must not be null');
  // Web Crypto only accepts integer TypedArrays; match Node's TypeMismatchError.
  if (!INTEGER_ARRAYS.some((T) => array instanceof T)) {
    throw new DOMException('getRandomValues: expected an integer TypedArray', 'TypeMismatchError');
  }
  if (array.byteLength > MAX_GET_RANDOM_VALUES_BYTES) {
    throw new DOMException('getRandomValues: byteLength exceeds 65536', 'QuotaExceededError');
  }
  readUrandomInto(asBytes(array));
  return array;
}

/** Uniform double in [0, 1) from 53 random bits. */
function mathRandom(): number {
  const b = Buffer.allocUnsafe(8);
  readUrandomInto(b);
  return Number(b.readBigUInt64BE() >> 11n) / 2 ** 53;
}

type IntCallback = (err: Error | null, value: number) => void;

/** `crypto.randomInt([min,] max[, callback])` with Node's range rules; rejection-sampled. */
function randomInt(a: number, b?: number | IntCallback, c?: IntCallback): number | void {
  const [min, max, cb] =
    typeof b === 'function' || b === undefined ? [0, a, b as IntCallback | undefined] : [a, b, c];
  const draw = (): number => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
      throw new TypeError('randomInt: min and max must be safe integers');
    }
    const range = max - min;
    // Node rejects a range of exactly 2^48 too (ERR_OUT_OF_RANGE).
    if (range <= 0 || range >= RANDOM_INT_MAX_RANGE) {
      throw new RangeError(`randomInt: max - min must be in (0, ${RANDOM_INT_MAX_RANGE})`);
    }
    const limit = RANDOM_INT_MAX_RANGE - (RANDOM_INT_MAX_RANGE % range);
    const buf = Buffer.allocUnsafe(6);
    for (;;) {
      readUrandomInto(buf);
      const x = buf.readUIntBE(0, 6);
      if (x < limit) return min + (x % range);
    }
  };
  if (!cb) return draw();
  try {
    process.nextTick(cb, null, draw());
  } catch (err) {
    process.nextTick(cb, err as Error, 0);
  }
}

/**
 * Route Node's crypto RNG entry points through /dev/urandom.
 * No-op unless `RUNTIME_PLATFORM_VERSION=V2` (set by CDK) — V1 never snapshots.
 * @returns true when the patch is active
 */
export function installSnapshotSafeRandom(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.RUNTIME_PLATFORM_VERSION !== 'V2') return false;
  if (originals) return true;

  const web = globalThis.crypto;
  originals = {
    randomBytes: crypto.randomBytes,
    randomFillSync: crypto.randomFillSync,
    randomFill: crypto.randomFill,
    randomUUID: crypto.randomUUID,
    randomInt: crypto.randomInt,
    mathRandom: Math.random,
    webRandomUUID: Object.getOwnPropertyDescriptor(web, 'randomUUID'),
    webGetRandomValues: Object.getOwnPropertyDescriptor(web, 'getRandomValues'),
  };

  const mutable = crypto as unknown as Record<string, unknown>;
  mutable.randomBytes = randomBytes;
  mutable.randomFillSync = randomFillSync;
  mutable.randomFill = randomFill;
  mutable.randomUUID = randomUUID;
  mutable.randomInt = randomInt;
  Math.random = mathRandom;
  // `crypto.webcrypto` and `globalThis.crypto` are the same object; the methods
  // live on Crypto.prototype, so own properties shadow them. node:crypto's
  // `getRandomValues` is a getter-only export that delegates here.
  Object.defineProperty(web, 'randomUUID', {
    value: randomUUID,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(web, 'getRandomValues', {
    value: getRandomValues,
    configurable: true,
    writable: true,
  });
  // Propagate to `import { randomUUID } from 'node:crypto'` live bindings.
  syncBuiltinESMExports();
  return true;
}

/** Test-only: restore the original implementations. */
export function uninstallSnapshotSafeRandom(): void {
  if (!originals) return;
  const mutable = crypto as unknown as Record<string, unknown>;
  mutable.randomBytes = originals.randomBytes;
  mutable.randomFillSync = originals.randomFillSync;
  mutable.randomFill = originals.randomFill;
  mutable.randomUUID = originals.randomUUID;
  mutable.randomInt = originals.randomInt;
  Math.random = originals.mathRandom;
  const web = globalThis.crypto as unknown as Record<string, unknown>;
  if (originals.webRandomUUID) Object.defineProperty(web, 'randomUUID', originals.webRandomUUID);
  else delete web.randomUUID;
  if (originals.webGetRandomValues) {
    Object.defineProperty(web, 'getRandomValues', originals.webGetRandomValues);
  } else delete web.getRandomValues;
  syncBuiltinESMExports();
  originals = null;
}
