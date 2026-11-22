import { z } from 'zod';

/** Upper bounds per record: one model call never comes close; they stop absurd inputs. */
const tokens = (max: number) => z.number().int().min(0).max(max);

export const usageRecordsBody = z.object({
  /**
   * Same on every retry of a batch; the Backend applies a batch at most once.
   * Optional only so a Runtime from before this field keeps metering during a
   * rolling deploy (its batches are then not de-duplicated).
   */
  batchId: z.string().uuid().optional(),
  records: z
    .array(
      z.object({
        recordId: z.string().uuid(),
        modelId: z.string().min(1).max(200),
        /** Client-side timestamp, kept for analysis only; the month uses the server clock. */
        at: z.string().datetime().optional(),
        uncachedInputTokens: tokens(5_000_000),
        cacheReadInputTokens: tokens(5_000_000),
        cacheWriteInputTokens: tokens(5_000_000),
        outputTokens: tokens(1_000_000),
      })
    )
    .min(1)
    .max(50),
});
