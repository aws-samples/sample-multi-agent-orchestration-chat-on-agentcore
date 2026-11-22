/**
 * Monthly token usage.
 *
 *   GET  /usage/me       — this month's usage and limits (frontend + Runtime)
 *   POST /usage/records  — usage reported by the Runtime after each model call
 *
 * Both act on the caller (regular user) or `X-Target-User-Id` (machine user).
 */

import { randomUUID } from 'node:crypto';
import { Router, type Response, type NextFunction } from 'express';
import {
  getCurrentAuth,
  resolveTargetUser,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { AppError, ErrorCode, ok } from '../libs/http/index.js';
import { getUsageService } from '../services/usage-service.js';
import { getGroupsForUserSub } from '../services/cognito-groups.js';
import { usageRecordsBody } from './usage-schemas.js';

const router = Router();

/**
 * Per-user cap on POST /usage/records. Each recorder posts at most every ~5 s
 * (~12/min), and a user can run many at once (parallel workflow steps,
 * sub-agents, triggers), so the cap is generous; a 429 is re-queued, not lost,
 * so this only bites on direct abuse that would otherwise exhaust Lambda
 * concurrency and push every caller into fail-open. Per Lambda instance —
 * approximate by design.
 */
export const RECORDS_PER_MINUTE = 600;
const windows = new Map<string, { start: number; count: number }>();

let lastSweep = 0;

/** Drop expired windows (at most once a minute) so the map cannot grow without bound. */
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, w] of windows) if (now - w.start >= 60_000) windows.delete(key);
}

function rateLimit(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const key = req.targetUserId!;
  const now = Date.now();
  sweep(now);
  const w = windows.get(key);
  if (!w || now - w.start >= 60_000) {
    windows.set(key, { start: now, count: 1 });
  } else if (++w.count > RECORDS_PER_MINUTE) {
    throw new AppError(ErrorCode.RATE_LIMITED, 'Too many usage reports');
  }
  next();
}

/** Test hook. */
export function rateLimitWindowCount(): number {
  return windows.size;
}

export function resetRateLimitForTest(): void {
  windows.clear();
  lastSweep = 0;
}

async function groupsOf(req: AuthenticatedRequest): Promise<string[]> {
  const auth = getCurrentAuth(req);
  return auth.isMachineUser ? getGroupsForUserSub(req.targetUserId!) : auth.groups;
}

router.get(
  '/me',
  resolveTargetUser,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const service = getUsageService();
    const groups = service.enabled ? await groupsOf(req) : [];
    const summary = await service.getSummary(req.targetUserId!, groups);
    res.status(200).json(ok(req, { ...summary }));
  })
);

router.post(
  '/records',
  resolveTargetUser,
  rateLimit,
  validate({ body: usageRecordsBody }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    await getUsageService().record(
      req.targetUserId!,
      req.body.batchId ?? randomUUID(),
      req.body.records
    );
    res.status(204).end();
  })
);

export default router;
