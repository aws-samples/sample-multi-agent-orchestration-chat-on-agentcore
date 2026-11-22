/**
 * Display formatting for monthly token usage (settings table, model selector
 * badges, chat notices).
 */

import type { TFunction } from 'i18next';
import {
  TOKEN_LIMIT_WARNING_RATIO,
  exceededDimension,
  modelUsageKey,
  type ModelUsage,
  type UsageStatus,
  type UsageSummary,
} from '@moca/core';
import { AVAILABLE_MODELS, type BedrockModel } from '../config/models';

const UNITS: ReadonlyArray<[number, string]> = [
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
];

/** 82_100_000 → "82.1M", 500_000 → "500K", 100_000_000 → "100M", 950 → "950". */
export function formatTokenCount(value: number): string {
  for (const [size, unit] of UNITS) {
    if (Math.abs(value) >= size) {
      const scaled = value / size;
      // One decimal below 100 (82.1M); integers above (100M, 500K).
      const text = Math.abs(scaled) >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1);
      return `${text.replace(/\.0$/, '')}${unit}`;
    }
  }
  return String(Math.round(value));
}

/** Share of `limit` used, as a whole percent (limit 0 counts as full). */
export function usagePercent(used: number, limit: number): number {
  if (limit <= 0) return 100;
  return Math.floor((used / limit) * 100);
}

function zonedParts(iso: string, timeZone: string): Record<string, string> | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date);
    return Object.fromEntries(parts.map((p) => [p.type, p.value]));
  } catch {
    return null;
  }
}

/** Reset instant as "M/D HH:mm" in the limit's time zone, e.g. "12/1 00:00". */
export function formatResetAt(iso: string, timeZone: string): string {
  const p = zonedParts(iso, timeZone);
  if (!p) return iso;
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

// Intl renders Asia/Tokyo as "GMT+9"; users know it as JST.
const TIME_ZONE_ABBREVIATIONS: Readonly<Record<string, string>> = { 'Asia/Tokyo': 'JST' };

export function timeZoneAbbreviation(timeZone: string): string {
  if (TIME_ZONE_ABBREVIATIONS[timeZone]) return TIME_ZONE_ABBREVIATIONS[timeZone];
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    return name ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** "2026-11" → "2026年11月" (ja) / "November 2026" (en). */
export function formatUsageMonth(month: string, locale: string): string {
  const [year, mon] = month.split('-').map(Number);
  if (!year || !mon) return month;
  // Mid-month noon UTC is inside the same calendar month in every time zone.
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, mon - 1, 15, 12)));
}

/** Display name of the configured model that meters into `modelKey`, else the key. */
export function modelNameForUsageKey(modelKey: string): string {
  return AVAILABLE_MODELS.find((m) => modelUsageKey(m.id) === modelKey)?.name ?? modelKey;
}

export type UsageLevel = 'normal' | 'warning' | 'exceeded';

/** Same thresholds as the backend's usageStatus (80% warning, 100% exceeded). */
export function usageLevel(used: number, limit: number): UsageLevel {
  const ratio = limit <= 0 ? 1 : used / limit;
  if (ratio >= 1) return 'exceeded';
  if (ratio >= TOKEN_LIMIT_WARNING_RATIO) return 'warning';
  return 'normal';
}

const STATUS_ORDER: Record<UsageStatus, number> = { exceeded: 0, warning: 1, ok: 2 };

export type UsageRow = ModelUsage & { name: string };

/** Settings table order: exceeded, warning, then the rest; by display name within each. */
export function sortUsageRows(models: readonly ModelUsage[]): UsageRow[] {
  return models
    .map((m) => ({ ...m, name: modelNameForUsageKey(m.modelKey) }))
    .sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name)
    );
}

/** Per-model token-limit state as the model selector displays it. */
export interface ModelUsageIndicator {
  status: UsageStatus;
  /** Why the model is unavailable and when it resets (exceeded only). */
  description?: string;
}

export function modelUsageIndicator(
  summary: UsageSummary | null,
  modelId: string,
  t: TFunction
): ModelUsageIndicator | undefined {
  if (!summary?.enabled) return undefined;
  const key = modelUsageKey(modelId);
  const usage = summary.models.find((m) => m.modelKey === key);
  if (!usage) return undefined;
  if (usage.status !== 'exceeded') return { status: usage.status };
  const dimension = exceededDimension(usage) ?? 'input';
  return {
    status: 'exceeded',
    description: t('common.usageBadge.exceededDescription', {
      dimension: t(
        dimension === 'input' ? 'common.usageDimension.input' : 'common.usageDimension.output'
      ),
      limit: formatTokenCount(usage[dimension].limit ?? 0),
      resetsAt: formatResetAt(summary.period.resetsAt, summary.period.timezone),
    }),
  };
}

/**
 * Model for "resend with another model" after a refusal on `exceededKey`: the
 * selected model if usable (the user may already have switched), else the
 * first configured model that meters elsewhere and is not over its own limit.
 */
export function pickRetryModel(
  exceededKey: string,
  selectedModelId: string,
  isExceeded: (modelId: string) => boolean
): BedrockModel | undefined {
  const usable = (m: BedrockModel) => modelUsageKey(m.id) !== exceededKey && !isExceeded(m.id);
  const selected = AVAILABLE_MODELS.find((m) => m.id === selectedModelId);
  if (selected && usable(selected)) return selected;
  return AVAILABLE_MODELS.find(usable);
}
