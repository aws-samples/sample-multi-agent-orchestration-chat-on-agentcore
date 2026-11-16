/**
 * The worker wrapper: a decode can be cancelled or time out, and either way the
 * single worker slot is released for the next call.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { fitImageOffThread } from '../fit-image-off-thread.js';
import { pngOf, solid } from './images.js';

let large: Buffer;
const small = () => pngOf(solid(40, 30));
// A region forces a decode; without one a small image is passed straight through.
const REGION = { x: 0, y: 0, width: 20, height: 20 };

beforeAll(async () => {
  large = await pngOf(solid(3000, 2000));
});

describe('fitImageOffThread', () => {
  it('returns the fitted image from the worker', async () => {
    const fitted = await fitImageOffThread({ data: await small(), format: 'png' }, REGION);

    expect(fitted).toMatchObject({ width: 20, height: 20, format: 'png' });
    expect(Buffer.isBuffer(fitted.bytes)).toBe(true);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      fitImageOffThread({ data: large, format: 'png' }, undefined, { signal: controller.signal })
    ).rejects.toThrow('cancelled');
  });

  it('rejects a call cancelled before it gets the slot', async () => {
    const controller = new AbortController();
    const pending = fitImageOffThread({ data: large, format: 'png' }, undefined, {
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow('cancelled');
  });

  it('stops a decode that is already running when the turn is cancelled', async () => {
    const controller = new AbortController();
    const pending = fitImageOffThread({ data: large, format: 'png' }, undefined, {
      signal: controller.signal,
    });
    // Worker start-up plus a 6 MP decode and re-encode take far longer than this.
    setTimeout(() => controller.abort(), 100);

    await expect(pending).rejects.toThrow('cancelled');
  });

  it('stops a decode that exceeds the timeout', async () => {
    await expect(
      fitImageOffThread({ data: large, format: 'png' }, undefined, { timeoutMs: 1 })
    ).rejects.toThrow('took longer than');
  });

  it('frees the slot after a cancelled or timed-out call', async () => {
    const controller = new AbortController();
    const cancelled = fitImageOffThread({ data: large, format: 'png' }, undefined, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).rejects.toThrow('cancelled');
    await expect(
      fitImageOffThread({ data: large, format: 'png' }, undefined, { timeoutMs: 1 })
    ).rejects.toThrow('took longer than');

    const fitted = await fitImageOffThread({ data: await small(), format: 'png' }, REGION);
    expect(fitted.width).toBe(20);
  });

  it('runs queued calls one after another, and drops a queued call that is cancelled', async () => {
    const order: string[] = [];
    const controller = new AbortController();
    const data = await small();

    const first = fitImageOffThread({ data, format: 'png' }, REGION).then(() =>
      order.push('first')
    );
    const queued = fitImageOffThread({ data, format: 'png' }, REGION, {
      signal: controller.signal,
    }).catch((error: Error) => order.push(`queued: ${error.message}`));
    const third = fitImageOffThread({ data, format: 'png' }, REGION).then(() =>
      order.push('third')
    );
    controller.abort();

    await Promise.all([first, queued, third]);
    expect(order).toEqual(['queued: Image processing was cancelled', 'first', 'third']);
  });
});
