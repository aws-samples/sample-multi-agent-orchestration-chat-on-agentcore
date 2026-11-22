/**
 * Monthly per-model token limits — policy (config + groups) and metering.
 *
 * The backend is the only writer of usage (see docs/adr/token-usage-limits.md):
 * the Runtime reports usage through POST /usage/records with the caller's own
 * JWT, so a user calling that route directly can only add to their own usage.
 */

import {
  DEFAULT_TOKEN_LIMIT_TIMEZONE,
  OTHER_MODEL_KEY,
  configuredModelKeys,
  modelUsageKey,
  resolveModelLimit,
  usageMonth,
  usageMonthResetsAt,
  usageStatus,
  type ModelUsage,
  type TokenLimitsConfig,
  type TokenLimitsConfigInput,
  parseAllowedModelIds,
  type UsageSummary,
  type UserId,
} from '@moca/core';
import { IMAGE_TO_TEXT_MODEL_IDS } from '@moca/tool-definitions';
import { config } from '../config/index.js';
import { logger } from '../libs/logger/index.js';
import type { UsageDelta, UsageRepository } from '../repositories/usage/index.js';
import { getUsageRepository } from '../repositories/usage/usage-repository.factory.js';

export interface UsageRecordInput {
  readonly modelId: string;
  readonly uncachedInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
}

/**
 * Parse `TOKEN_LIMITS_CONFIG` (the `tokenLimits` block of environments.ts).
 * The metering allow-list is the deployment's models plus the image_to_text
 * vision models, which call Bedrock outside the model selector.
 */
export function parseTokenLimitsConfig(
  raw: string | undefined,
  allowedModelIds: readonly string[] = []
): TokenLimitsConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TokenLimitsConfigInput;
    return {
      ...parsed,
      timezone: parsed.timezone || DEFAULT_TOKEN_LIMIT_TIMEZONE,
      allowedModelKeys: [...allowedModelIds, ...IMAGE_TO_TEXT_MODEL_IDS],
    };
  } catch (err) {
    logger.error({ err }, 'TOKEN_LIMITS_CONFIG is not valid JSON; token limits are disabled');
    return null;
  }
}

export class UsageService {
  private readonly allowed: Set<string>;

  constructor(
    private readonly limits: TokenLimitsConfig | null,
    private readonly repo: UsageRepository
  ) {
    this.allowed = new Set((limits?.allowedModelKeys ?? []).map(modelUsageKey));
  }

  get enabled(): boolean {
    return this.limits !== null && this.repo.isConfigured();
  }

  /** Metering key; models outside the deployment's allow-list share one row. */
  meteringKey(modelId: string): string {
    const key = modelUsageKey(modelId);
    return this.allowed.has(key) ? key : OTHER_MODEL_KEY;
  }

  async getSummary(
    userId: UserId,
    groups: readonly string[],
    now = new Date()
  ): Promise<UsageSummary> {
    const timezone = this.limits?.timezone ?? DEFAULT_TOKEN_LIMIT_TIMEZONE;
    const month = usageMonth(now, timezone);
    const period = { month, timezone, resetsAt: usageMonthResetsAt(month, timezone) };
    if (!this.enabled) return { enabled: false, period, groups: [], models: [] };

    const cfg = this.limits!;
    const rows = await this.repo.getMonth(userId, month);
    // Every limited model is listed — including ones limited only by `default`
    // and not used yet this month — so the Runtime never mistakes "no row" for
    // "no limit".
    const keys = new Set([
      ...rows.map((r) => r.modelKey),
      ...configuredModelKeys(cfg, groups),
      ...[...this.allowed].filter((key) => {
        const l = resolveModelLimit(cfg, groups, key);
        return l.input !== null || l.output !== null;
      }),
    ]);
    const effectiveGroups = groups.filter((g) => cfg.groups?.[g] !== undefined);
    const models: ModelUsage[] = [];
    for (const modelKey of keys) {
      const row = rows.find((r) => r.modelKey === modelKey);
      const limit = resolveModelLimit(cfg, groups, modelKey);
      const input = { used: row?.inputTokens ?? 0, limit: limit.input };
      const output = { used: row?.outputTokens ?? 0, limit: limit.output };
      models.push({ modelKey, input, output, status: usageStatus(input, output) });
    }
    return { enabled: true, period, groups: effectiveGroups, models };
  }

  /**
   * Add records to this month's rows. The month comes from the server clock,
   * never from the client (a turn straddling midnight lands in the new month).
   */
  async record(
    userId: UserId,
    batchId: string,
    records: readonly UsageRecordInput[],
    now = new Date()
  ): Promise<'applied' | 'duplicate' | 'disabled'> {
    if (!this.enabled) return 'disabled';
    const month = usageMonth(now, this.limits!.timezone);
    const byKey = new Map<string, UsageDelta>();
    for (const r of records) {
      const key = this.meteringKey(r.modelId);
      const prev = byKey.get(key);
      byKey.set(key, {
        uncachedInputTokens: (prev?.uncachedInputTokens ?? 0) + r.uncachedInputTokens,
        cacheReadInputTokens: (prev?.cacheReadInputTokens ?? 0) + r.cacheReadInputTokens,
        cacheWriteInputTokens: (prev?.cacheWriteInputTokens ?? 0) + r.cacheWriteInputTokens,
        outputTokens: (prev?.outputTokens ?? 0) + r.outputTokens,
        calls: (prev?.calls ?? 0) + 1,
      });
    }
    return this.repo.addBatch(userId, month, batchId, byKey);
  }
}

let instance: UsageService | null = null;

export function getUsageService(): UsageService {
  instance ??= new UsageService(
    parseTokenLimitsConfig(
      config.TOKEN_LIMITS_CONFIG,
      parseAllowedModelIds(config.BEDROCK_MODEL_IDS)
    ),
    getUsageRepository()
  );
  return instance;
}
