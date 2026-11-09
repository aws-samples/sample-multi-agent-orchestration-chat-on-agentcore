import { describe, it, expect } from 'vitest';
import { settleWithConcurrency } from '../settleWithConcurrency';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('settleWithConcurrency', () => {
  it('never runs more than `limit` tasks at once', async () => {
    let inFlight = 0;
    let peak = 0;
    await settleWithConcurrency([1, 2, 3, 4, 5, 6, 7], 2, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    });
    expect(peak).toBe(2);
  });

  it('keeps input order and settles failures without aborting the rest', async () => {
    const results = await settleWithConcurrency(['a', 'b', 'c'], 2, async (x) => {
      await tick();
      if (x === 'b') throw new Error('boom');
      return x.toUpperCase();
    });
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect((results[0] as PromiseFulfilledResult<string>).value).toBe('A');
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
  });

  it('handles an empty list', async () => {
    await expect(settleWithConcurrency([], 2, async () => 1)).resolves.toEqual([]);
  });
});
