import { afterEach, describe, expect, it } from '@jest/globals';
import crypto from 'node:crypto';
import {
  installSnapshotSafeRandom,
  readUrandomInto,
  uninstallSnapshotSafeRandom,
} from './snapshot-safe-random.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('installSnapshotSafeRandom', () => {
  afterEach(() => uninstallSnapshotSafeRandom());

  it('is a no-op unless RUNTIME_PLATFORM_VERSION is V2', () => {
    const original = crypto.randomUUID;
    expect(installSnapshotSafeRandom({})).toBe(false);
    expect(installSnapshotSafeRandom({ RUNTIME_PLATFORM_VERSION: 'V1' })).toBe(false);
    expect(crypto.randomUUID).toBe(original);
  });

  // ESM named-import propagation (syncBuiltinESMExports) is not observable under
  // jest's VM modules, which wrap builtins in their own synthetic modules.
  it('replaces node:crypto and globalThis.crypto on V2', () => {
    const original = crypto.randomUUID;
    const originalWeb = globalThis.crypto.randomUUID;
    expect(installSnapshotSafeRandom({ RUNTIME_PLATFORM_VERSION: 'V2' })).toBe(true);

    expect(crypto.randomUUID).not.toBe(original);
    expect(globalThis.crypto.randomUUID).not.toBe(originalWeb);

    uninstallSnapshotSafeRandom();
    expect(crypto.randomUUID).toBe(original);
    expect(globalThis.crypto.randomUUID()).toMatch(UUID_V4);
  });

  it('produces valid, distinct v4 UUIDs from every entry point', () => {
    installSnapshotSafeRandom({ RUNTIME_PLATFORM_VERSION: 'V2' });
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const a = crypto.randomUUID();
      const b = globalThis.crypto.randomUUID();
      expect(a).toMatch(UUID_V4);
      expect(b).toMatch(UUID_V4);
      ids.add(a).add(b);
    }
    expect(ids.size).toBe(400);
  });

  it('fills buffers via randomBytes / randomFillSync / getRandomValues', () => {
    installSnapshotSafeRandom({ RUNTIME_PLATFORM_VERSION: 'V2' });

    expect(crypto.randomBytes(32)).toHaveLength(32);

    const buf = Buffer.alloc(16);
    crypto.randomFillSync(buf, 4, 8);
    expect(buf.subarray(0, 4).every((x) => x === 0)).toBe(true);
    expect(buf.subarray(12).every((x) => x === 0)).toBe(true);

    // offset/size are element-based for wider TypedArrays, matching Node.
    const u32 = new Uint32Array(4);
    crypto.randomFillSync(u32, 3, 1);
    expect([u32[0], u32[1], u32[2]]).toEqual([0, 0, 0]);

    expect(() => crypto.randomFillSync(Buffer.alloc(4), 2, 4)).toThrow(RangeError);

    const arr = new Uint8Array(64);
    expect(globalThis.crypto.getRandomValues(arr)).toBe(arr);
    expect(arr.some((x) => x !== 0)).toBe(true);
    expect(() => globalThis.crypto.getRandomValues(new Uint8Array(65537))).toThrow();
    // node:crypto's getter-only export delegates to globalThis.crypto.
    expect(() => crypto.getRandomValues(new Uint8Array(65537))).toThrow(/65536/);
  });

  it('supports the callback forms of randomBytes and randomFill', async () => {
    installSnapshotSafeRandom({ RUNTIME_PLATFORM_VERSION: 'V2' });
    const bytes = await new Promise<Buffer>((resolve, reject) =>
      crypto.randomBytes(8, (err, b) => (err ? reject(err) : resolve(b)))
    );
    expect(bytes).toHaveLength(8);

    const filled = await new Promise<Buffer>((resolve, reject) =>
      crypto.randomFill(Buffer.alloc(8), (err, b) => (err ? reject(err) : resolve(b)))
    );
    expect(filled).toHaveLength(8);
  });
});

describe('installSnapshotSafeRandom — Math.random / randomInt / input types', () => {
  afterEach(() => uninstallSnapshotSafeRandom());

  it('replaces and restores Math.random and crypto.randomInt', () => {
    const origMath = Math.random;
    const origInt = crypto.randomInt;
    installSnapshotSafeRandom({ RUNTIME_PLATFORM_VERSION: 'V2' });
    expect(Math.random).not.toBe(origMath);
    expect(crypto.randomInt).not.toBe(origInt);
    uninstallSnapshotSafeRandom();
    expect(Math.random).toBe(origMath);
    expect(crypto.randomInt).toBe(origInt);
  });

  it('Math.random returns distinct doubles in [0, 1)', () => {
    installSnapshotSafeRandom({ RUNTIME_PLATFORM_VERSION: 'V2' });
    const values = Array.from({ length: 500 }, () => Math.random());
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(new Set(values).size).toBe(500);
  });

  it('randomInt honours [min,] max and the callback form', async () => {
    installSnapshotSafeRandom({ RUNTIME_PLATFORM_VERSION: 'V2' });
    const seen = new Set<number>();
    for (let i = 0; i < 300; i++) {
      const v = crypto.randomInt(3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(3);
      seen.add(v);
      const w = crypto.randomInt(-5, -2);
      expect(w).toBeGreaterThanOrEqual(-5);
      expect(w).toBeLessThan(-2);
    }
    expect(seen.size).toBe(3);

    const v = await new Promise<number>((resolve, reject) =>
      crypto.randomInt(10, 20, (err, n) => (err ? reject(err) : resolve(n)))
    );
    expect(v).toBeGreaterThanOrEqual(10);
    expect(v).toBeLessThan(20);

    expect(() => crypto.randomInt(5, 5)).toThrow(RangeError);
    expect(() => crypto.randomInt(0, 2 ** 48 + 1)).toThrow(RangeError);
    expect(() => crypto.randomInt(1.5)).toThrow(TypeError);
  });

  it('accepts SharedArrayBuffer and rejects non-integer arrays like Web Crypto', () => {
    installSnapshotSafeRandom({ RUNTIME_PLATFORM_VERSION: 'V2' });
    const sab = new SharedArrayBuffer(16);
    crypto.randomFillSync(sab);
    expect(new Uint8Array(sab).some((x) => x !== 0)).toBe(true);

    expect(() => globalThis.crypto.getRandomValues(new Float32Array(4) as never)).toThrow(
      /integer TypedArray/
    );
    expect(() =>
      globalThis.crypto.getRandomValues(new DataView(new ArrayBuffer(4)) as never)
    ).toThrow(/integer TypedArray/);
    expect(globalThis.crypto.getRandomValues(new BigUint64Array(2))).toHaveLength(2);
  });
});

describe('readUrandomInto', () => {
  it('fills only the requested range', () => {
    const b = new Uint8Array(8);
    readUrandomInto(b, 2, 0);
    expect(b.every((x) => x === 0)).toBe(true);
  });
});
