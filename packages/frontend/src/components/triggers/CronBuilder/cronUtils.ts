/**
 * Cron Builder Utility Functions
 *
 * AWS EventBridge Scheduler Cron format (6 fields):
 * minute hour day-of-month month day-of-week year
 *
 * Example: 0 9 * * MON-FRI * (Every weekday at 9:00 AM)
 */

import type { TFunction } from 'i18next';

export interface CronFields {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
  year: string;
}

export interface CronPreset {
  id: string;
  label: string;
  expression: string;
}

/**
 * Predefined cron presets
 */
export const CRON_PRESETS: CronPreset[] = [
  // NOTE: `everyMinute` preset intentionally removed — cron expressions that
  // fire more often than once per minute are blocked by both the UI
  // (`validateScheduleInterval`) and the backend
  // (`scheduler-service.ts#assertMinimumInterval`). A once-per-minute cadence
  // risks hitting the `GetOpenIdTokenForDeveloperIdentity` 25 TPS hard quota
  // when multiple users schedule the same cron. See
  // `docs/event-driven-identity-pool-credentials.md` > Quotas & Rate Limits.
  {
    id: 'everyHour',

    label: 'triggers.cron.presetEveryHour',
    expression: '0 * * * ? *',
  },
  {
    id: 'everyDay',
    label: 'triggers.cron.presetEveryDay',
    expression: '0 0 * * ? *',
  },
  {
    id: 'everyWeekday',
    label: 'triggers.cron.presetEveryWeekday',
    expression: '0 0 ? * MON-FRI *',
  },
  {
    id: 'everyMonday',
    label: 'triggers.cron.presetEveryMonday',
    expression: '0 0 ? * MON *',
  },
  {
    id: 'everyMonth',
    label: 'triggers.cron.presetEveryMonth',
    expression: '0 0 1 * ? *',
  },
];

/**
 * Parse cron expression into fields
 */
export function parseCronExpression(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);

  if (parts.length !== 6) {
    return null;
  }

  return {
    minute: parts[0],
    hour: parts[1],
    dayOfMonth: parts[2],
    month: parts[3],
    dayOfWeek: parts[4],
    year: parts[5],
  };
}

/**
 * Build cron expression from fields
 */
export function buildCronExpression(fields: CronFields): string {
  return `${fields.minute} ${fields.hour} ${fields.dayOfMonth} ${fields.month} ${fields.dayOfWeek} ${fields.year}`;
}

/**
 * Validate cron expression
 */
export function validateCronExpression(expression: string): boolean {
  const fields = parseCronExpression(expression);
  if (!fields) return false;

  // Basic validation - check that either dayOfMonth or dayOfWeek has '?'
  const hasDayOfMonth = fields.dayOfMonth !== '?';
  const hasDayOfWeek = fields.dayOfWeek !== '?';

  // Exactly one of dayOfMonth or dayOfWeek must be '?'
  if (hasDayOfMonth === hasDayOfWeek) {
    return false;
  }

  return true;
}

/**
 * Threshold (in minutes) below which we warn the user that the schedule
 * may incur unexpected cost (Lambda invocations, Bedrock calls, Cognito
 * token issuance). Schedules >= this threshold are considered "safe".
 */
export const COST_WARNING_THRESHOLD_MINUTES = 60;

/**
 * Hard minimum interval (in minutes). Schedules below this are rejected
 * outright — both in the UI and by the backend — to protect the
 * `GetOpenIdTokenForDeveloperIdentity` 25 TPS hard quota.
 */
export const MINIMUM_INTERVAL_MINUTES = 1;

/**
 * Estimate the minimum interval (in minutes) between executions of the
 * given schedule expression.
 *
 * Accepts both EventBridge `cron(...)` expressions (6 fields) and
 * `rate(N unit)` expressions. Returns `null` when the expression cannot
 * be parsed or the cadence cannot be determined.
 *
 * IMPORTANT: This function has a mirrored copy in the backend at
 * `packages/backend/src/services/scheduler-service.ts`. When changing
 * the logic here, apply the same change there to keep UI and API
 * validation in sync.
 */
export function getMinimumIntervalMinutes(expression: string): number | null {
  const trimmed = expression.trim();

  // rate(N unit) expressions
  const rateMatch = trimmed.match(
    /^(?:rate\(|rate\s+)(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|days?)\)?$/i
  );
  if (rateMatch) {
    const value = parseFloat(rateMatch[1]);
    const unit = rateMatch[2].toLowerCase().replace(/s$/, '');
    switch (unit) {
      case 'second':
        return value / 60;
      case 'minute':
        return value;
      case 'hour':
        return value * 60;
      case 'day':
        return value * 60 * 24;
      default:
        return null;
    }
  }

  // Strip surrounding cron(...) wrapper if present
  const cronBody = trimmed.replace(/^cron\(|\)$/g, '').trim();
  const fields = parseCronExpression(cronBody);
  if (!fields) return null;

  // Analyse the minute field to derive the smallest gap between fires
  // within a single hour. Combined with the hour field we can decide
  // whether the cron fires hourly or sparser.
  const minuteGap = deriveMinuteGap(fields.minute);
  if (minuteGap === null) return null;

  const hourGap = deriveHourGap(fields.hour);
  if (hourGap === null) return null;

  // When minute is a single concrete value (gap = 60) the effective
  // cadence is hour-driven, so use hourGap directly.
  if (minuteGap === 60) {
    return hourGap * 60;
  }

  // Otherwise the minute field sets the cadence — but cap it at an hour
  // when the hour field is also restricted (e.g. "0,30 9 * * ? *" fires
  // twice at 9:00 and 9:30 then waits a day).
  if (hourGap > 1) {
    return hourGap * 60;
  }
  return minuteGap;
}

/**
 * Returns the gap (in minutes) between consecutive fires within an hour,
 * or 60 when the field resolves to exactly one fire per hour. Returns
 * null when the field cannot be interpreted.
 */
function deriveMinuteGap(minute: string): number | null {
  if (minute === '*') return 1;

  const stepMatch = minute.match(/^(\*|\d+)\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[2], 10);
    if (!Number.isFinite(step) || step <= 0) return null;
    return step;
  }

  if (minute.includes(',')) {
    const values = minute.split(',').map((v) => parseInt(v, 10));
    if (values.some((v) => !Number.isFinite(v))) return null;
    const sorted = [...values].sort((a, b) => a - b);
    let minGap = 60;
    for (let i = 1; i < sorted.length; i++) {
      minGap = Math.min(minGap, sorted[i] - sorted[i - 1]);
    }
    // Wrap-around gap (last of this hour → first of the next hour).
    minGap = Math.min(minGap, 60 - sorted[sorted.length - 1] + sorted[0]);
    return minGap;
  }

  if (minute.includes('-')) {
    const [start, end] = minute.split('-').map((v) => parseInt(v, 10));
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    // Range like 0-30 fires every minute within the window, so gap = 1.
    return 1;
  }

  // Single concrete value → one fire per hour.
  if (/^\d+$/.test(minute)) return 60;

  return null;
}

/**
 * Returns the gap (in hours) between consecutive fires across a day, or
 * 24 when the field resolves to exactly one fire per day. Returns null
 * when the field cannot be interpreted.
 */
function deriveHourGap(hour: string): number | null {
  if (hour === '*') return 1;

  const stepMatch = hour.match(/^(\*|\d+)\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[2], 10);
    if (!Number.isFinite(step) || step <= 0) return null;
    return step;
  }

  if (hour.includes(',')) {
    const values = hour.split(',').map((v) => parseInt(v, 10));
    if (values.some((v) => !Number.isFinite(v))) return null;
    const sorted = [...values].sort((a, b) => a - b);
    let minGap = 24;
    for (let i = 1; i < sorted.length; i++) {
      minGap = Math.min(minGap, sorted[i] - sorted[i - 1]);
    }
    minGap = Math.min(minGap, 24 - sorted[sorted.length - 1] + sorted[0]);
    return minGap;
  }

  if (hour.includes('-')) return 1;

  if (/^\d+$/.test(hour)) return 24;

  return null;
}

/**
 * Classify a schedule expression against the two thresholds:
 *   - `'too-short'` (< 1 min)  → must be blocked, never created
 *   - `'warning'`   (< 60 min) → allow but display a cost warning and
 *                                request explicit confirmation at submit
 *   - `'ok'`        (>= 60 min or indeterminate but daily+) → no warning
 *   - `'unknown'`   parse failure → treat conservatively as warning in
 *                  the UI so the user is at least nudged to double-check
 */
export function validateScheduleInterval(
  expression: string
): 'ok' | 'warning' | 'too-short' | 'unknown' {
  const minutes = getMinimumIntervalMinutes(expression);
  if (minutes === null) return 'unknown';
  if (minutes < MINIMUM_INTERVAL_MINUTES) return 'too-short';
  if (minutes < COST_WARNING_THRESHOLD_MINUTES) return 'warning';
  return 'ok';
}

/**
 * Get translated day name
 */
function getDayName(day: string, t: TFunction): string {
  const key = `triggers.cronDescription.days.${day}`;
  const translated = t(key);
  return translated !== key ? translated : day;
}

/**
 * Generate human-readable description of cron expression
 */
export function getCronDescription(expression: string, t: TFunction): string {
  const fields = parseCronExpression(expression);
  if (!fields) {
    return t('triggers.cron.invalidExpression');
  }

  const parts: string[] = [];

  // Handle presets first
  const preset = CRON_PRESETS.find((p) => p.expression === expression);
  if (preset) {
    return t(preset.label);
  }

  // Minute
  if (fields.minute === '*') {
    parts.push(t('triggers.cron.presetEveryMinute'));
  } else if (fields.minute === '0') {
    // Handle in hour section
  } else {
    parts.push(t('triggers.cronDescription.minute', { value: fields.minute }));
  }

  // Hour
  if (fields.hour === '*') {
    if (fields.minute === '0') {
      parts.push(t('triggers.cron.presetEveryHour'));
    }
  } else if (fields.hour !== '*') {
    parts.push(`${fields.hour}:${fields.minute.padStart(2, '0')}`);
  }

  // Day of month
  if (fields.dayOfMonth !== '?' && fields.dayOfMonth !== '*') {
    parts.push(t('triggers.cronDescription.day', { value: fields.dayOfMonth }));
  }

  // Day of week
  if (fields.dayOfWeek !== '?' && fields.dayOfWeek !== '*') {
    if (fields.dayOfWeek.includes('-')) {
      const [start, end] = fields.dayOfWeek.split('-');
      parts.push(
        t('triggers.cronDescription.dayRange', {
          start: getDayName(start, t),
          end: getDayName(end, t),
        })
      );
    } else if (fields.dayOfWeek.includes(',')) {
      const separator = t('triggers.cronDescription.dayList');
      const days = fields.dayOfWeek
        .split(',')
        .map((d) => getDayName(d, t))
        .join(separator);
      parts.push(days);
    } else {
      parts.push(getDayName(fields.dayOfWeek, t));
    }
  }

  // Month
  if (fields.month !== '*') {
    parts.push(t('triggers.cronDescription.month', { value: fields.month }));
  }

  return parts.join(' ') || expression;
}

/**
 * Calculate next execution times for a cron expression
 */
export function getNextExecutions(
  expression: string,
  _timezone: string,
  count: number = 3
): Date[] {
  const fields = parseCronExpression(expression);
  if (!fields || !validateCronExpression(expression)) {
    return [];
  }

  const executions: Date[] = [];
  let current = new Date();

  // Simple implementation - in production, use a proper cron parser like cron-parser
  // This is a basic approximation for common cases
  // Note: timezone parameter is not used in this simplified version

  for (let i = 0; i < count && executions.length < count; i++) {
    const next = calculateNextExecution(current, fields);
    if (next) {
      executions.push(next);
      current = new Date(next.getTime() + 60000); // Add 1 minute
    } else {
      break;
    }
  }

  return executions;
}

/**
 * Calculate next execution time (simplified)
 */
function calculateNextExecution(from: Date, fields: CronFields): Date | null {
  // This is a simplified implementation
  // In production, use a library like cron-parser or cronitor-cron

  const next = new Date(from);

  // Handle minute
  if (fields.minute === '*') {
    next.setMinutes(next.getMinutes() + 1);
  } else if (fields.minute !== '*') {
    const targetMinute = parseInt(fields.minute, 10);
    if (next.getMinutes() >= targetMinute) {
      next.setHours(next.getHours() + 1);
    }
    next.setMinutes(targetMinute);
  }
  next.setSeconds(0);
  next.setMilliseconds(0);

  // Handle hour
  if (fields.hour !== '*') {
    const targetHour = parseInt(fields.hour, 10);
    if (next.getHours() > targetHour || (next.getHours() === targetHour && next.getMinutes() > 0)) {
      next.setDate(next.getDate() + 1);
    }
    next.setHours(targetHour);
  }

  // Handle day of week (simplified)
  if (fields.dayOfWeek !== '?' && fields.dayOfWeek !== '*') {
    const dayMap: Record<string, number> = {
      SUN: 0,
      MON: 1,
      TUE: 2,
      WED: 3,
      THU: 4,
      FRI: 5,
      SAT: 6,
    };

    if (fields.dayOfWeek.includes('-')) {
      // Range like MON-FRI
      const [start, end] = fields.dayOfWeek.split('-');
      const startDay = dayMap[start];
      const endDay = dayMap[end];
      const currentDay = next.getDay();

      if (currentDay < startDay || currentDay > endDay) {
        // Move to next start day
        const daysToAdd = (startDay - currentDay + 7) % 7 || 7;
        next.setDate(next.getDate() + daysToAdd);
      }
    } else {
      // Specific day like MON
      const targetDay = dayMap[fields.dayOfWeek];
      const currentDay = next.getDay();
      if (currentDay !== targetDay) {
        const daysToAdd = (targetDay - currentDay + 7) % 7 || 7;
        next.setDate(next.getDate() + daysToAdd);
      }
    }
  }

  // Handle day of month
  if (fields.dayOfMonth !== '?' && fields.dayOfMonth !== '*') {
    const targetDay = parseInt(fields.dayOfMonth, 10);
    if (next.getDate() > targetDay) {
      next.setMonth(next.getMonth() + 1);
    }
    next.setDate(targetDay);
  }

  return next;
}

/**
 * Format date for display with locale support
 */
export function formatExecutionTime(date: Date, locale?: string): string {
  const displayLocale = locale || 'en-US';
  return date.toLocaleString(displayLocale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
}

/**
 * Available timezones (subset for common usage)
 */
export const TIMEZONES = [
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo (JST)' },
  { value: 'America/New_York', label: 'America/New_York (EST)' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles (PST)' },
  { value: 'Europe/London', label: 'Europe/London (GMT)' },
  { value: 'UTC', label: 'UTC' },
];

/**
 * Day of week option keys for i18n
 */
export const DAY_OF_WEEK_OPTION_KEYS = [
  { value: 'MON', labelKey: 'MON' },
  { value: 'TUE', labelKey: 'TUE' },
  { value: 'WED', labelKey: 'WED' },
  { value: 'THU', labelKey: 'THU' },
  { value: 'FRI', labelKey: 'FRI' },
  { value: 'SAT', labelKey: 'SAT' },
  { value: 'SUN', labelKey: 'SUN' },
];

/**
 * Get day of week options with translated labels
 */
export function getDayOfWeekOptions(t: TFunction): Array<{ value: string; label: string }> {
  return DAY_OF_WEEK_OPTION_KEYS.map(({ value, labelKey }) => ({
    value,
    label: t(`triggers.cronDescription.days.${labelKey}`),
  }));
}

/**
 * Month option keys for i18n
 */
export const MONTH_OPTION_KEYS = [
  { value: '1', labelKey: '1' },
  { value: '2', labelKey: '2' },
  { value: '3', labelKey: '3' },
  { value: '4', labelKey: '4' },
  { value: '5', labelKey: '5' },
  { value: '6', labelKey: '6' },
  { value: '7', labelKey: '7' },
  { value: '8', labelKey: '8' },
  { value: '9', labelKey: '9' },
  { value: '10', labelKey: '10' },
  { value: '11', labelKey: '11' },
  { value: '12', labelKey: '12' },
];

/**
 * Get month options with translated labels
 */
export function getMonthOptions(t: TFunction): Array<{ value: string; label: string }> {
  return MONTH_OPTION_KEYS.map(({ value, labelKey }) => ({
    value,
    label: t(`triggers.cronDescription.months.${labelKey}`),
  }));
}

// Legacy exports for backward compatibility
export const DAY_OF_WEEK_OPTIONS = DAY_OF_WEEK_OPTION_KEYS.map(({ value }) => ({
  value,
  label: value, // Will be translated at usage
}));

export const MONTH_OPTIONS = MONTH_OPTION_KEYS.map(({ value }) => ({
  value,
  label: value, // Will be translated at usage
}));
