/**
 * Zero-dependency cron parser for the scheduler plugin.
 *
 * Computes the next fire time for a standard 5-field cron expression
 * using UTC-only time handling. Plugins cannot import each other, so
 * this is an independent copy of the queue-plugin's cron calculator.
 *
 * @module
 */

/**
 * Parses a cron field into a set of valid values.
 *
 * Supports: asterisk, lists, ranges, and step values.
 *
 * @param field - The cron field value
 * @param min - Minimum valid value
 * @param max - Maximum valid value
 * @returns Set of valid values
 * @throws {Error} If the field is invalid
 */
function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  if (field === '*') {
    for (let i = min; i <= max; i++) {
      values.add(i);
    }
    return values;
  }

  // Handle step values: n-m/s
  const stepMatch = field.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (stepMatch) {
    const start = parseInt(stepMatch[1], 10);
    const end = parseInt(stepMatch[2], 10);
    const step = parseInt(stepMatch[3], 10);
    if (start < min || end > max || step <= 0) {
      throw new Error(`Invalid cron field: ${field}`);
    }
    for (let i = start; i <= end; i += step) {
      values.add(i);
    }
    return values;
  }

  // Handle step-only values: */n
  const stepOnlyMatch = field.match(/^\*\/(\d+)$/);
  if (stepOnlyMatch) {
    const step = parseInt(stepOnlyMatch[1], 10);
    if (step <= 0) {
      throw new Error(`Invalid cron field: ${field}`);
    }
    for (let i = min; i <= max; i += step) {
      values.add(i);
    }
    return values;
  }

  // Handle range: n-m
  const rangeMatch = field.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    if (start < min || end > max || start > end) {
      throw new Error(`Invalid cron field: ${field}`);
    }
    for (let i = start; i <= end; i++) {
      values.add(i);
    }
    return values;
  }

  // Handle list: n,m,o
  if (field.includes(',')) {
    const parts = field.split(',');
    for (const part of parts) {
      const n = parseInt(part, 10);
      if (isNaN(n) || n < min || n > max) {
        throw new Error(`Invalid cron field: ${field}`);
      }
      values.add(n);
    }
    return values;
  }

  // Handle single value
  const n = parseInt(field, 10);
  if (isNaN(n) || n < min || n > max) {
    throw new Error(`Invalid cron field: ${field}`);
  }
  values.add(n);

  return values;
}

/**
 * Validates a 5-field cron expression.
 *
 * @param cron - The cron expression (minute hour day month dayOfWeek)
 * @returns true if valid
 */
function isValidCron(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }
  try {
    parseField(parts[0], 0, 59); // minute
    parseField(parts[1], 0, 23); // hour
    parseField(parts[2], 1, 31); // day of month
    parseField(parts[3], 1, 12); // month
    parseField(parts[4], 0, 6); // day of week
    return true;
  } catch {
    return false;
  }
}

/**
 * Computes the next fire time for a cron expression.
 *
 * Supports standard 5-field cron: minute hour day-of-month month day-of-week.
 * Supports asterisk, lists, ranges, and step values.
 *
 * Day-of-month and day-of-week use OR semantics (standard cron behavior):
 * if both are specified, the job fires when either matches.
 *
 * All times are UTC.
 *
 * @param cron - The cron expression
 * @param fromMs - The timestamp to compute from (ms since epoch)
 * @returns The next fire time in ms since epoch
 * @throws {Error} If the cron expression is invalid
 *
 * @example
 * ```typescript
 * cronNextMs('* * * * *', now);       // Next minute
 * cronNextMs('0 9 * * 1-5', now);     // 9 AM on weekdays
 * cronNextMs('5 * * * *', now);       // Every hour at :05
 * ```
 * @since 0.1.0
 */
export function cronNextMs(cron: string, fromMs: number): number {
  if (!isValidCron(cron)) {
    throw new Error(`Invalid cron expression: ${cron}`);
  }

  const parts = cron.trim().split(/\s+/);
  const minutes = parseField(parts[0], 0, 59);
  const hours = parseField(parts[1], 0, 23);
  const daysOfMonth = parseField(parts[2], 1, 31);
  const months = parseField(parts[3], 1, 12);
  const daysOfWeek = parseField(parts[4], 0, 6);

  // Check if both DOM and DOW are specified (not just *)
  const domSpecified = parts[2] !== '*';
  const dowSpecified = parts[4] !== '*';

  // Start from the next minute
  const date = new Date(fromMs + 60000);

  // Search for up to 4 years (to handle leap years)
  const maxIterations = 366 * 24 * 60;
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    const month = date.getUTCMonth() + 1; // 1-12
    const dayOfMonth = date.getUTCDate(); // 1-31
    const dayOfWeek = date.getUTCDay(); // 0-6 (0 = Sunday)
    const hour = date.getUTCHours();
    const minute = date.getUTCMinutes();

    // Check month
    if (!months.has(month)) {
      // Advance to next valid month
      date.setUTCDate(1);
      date.setUTCHours(0, 0, 0, 0);
      let foundMonth = false;
      for (let m = month; m <= 12; m++) {
        if (months.has(m)) {
          date.setUTCMonth(m - 1);
          foundMonth = true;
          break;
        }
      }
      if (!foundMonth) {
        date.setUTCFullYear(date.getUTCFullYear() + 1);
        date.setUTCMonth(0);
        date.setUTCDate(1);
        date.setUTCHours(0, 0, 0, 0);
      }
      continue;
    }

    // Check day of month and day of week
    const domMatch = daysOfMonth.has(dayOfMonth);
    const dowMatch = daysOfWeek.has(dayOfWeek);

    if (domSpecified && dowSpecified) {
      // OR semantics: fire if either matches
      if (!domMatch && !dowMatch) {
        date.setUTCHours(23, 59, 59, 999);
        date.setUTCDate(date.getUTCDate() + 1);
        date.setUTCHours(0, 0, 0, 0);
        continue;
      }
    } else if (domSpecified) {
      if (!domMatch) {
        date.setUTCHours(23, 59, 59, 999);
        date.setUTCDate(date.getUTCDate() + 1);
        date.setUTCHours(0, 0, 0, 0);
        continue;
      }
    } else if (dowSpecified) {
      if (!dowMatch) {
        date.setUTCHours(23, 59, 59, 999);
        date.setUTCDate(date.getUTCDate() + 1);
        date.setUTCHours(0, 0, 0, 0);
        continue;
      }
    }

    // Check hour
    if (!hours.has(hour)) {
      // Advance to next valid hour
      let foundHour = false;
      for (let h = hour + 1; h <= 23; h++) {
        if (hours.has(h)) {
          date.setUTCHours(h, 0, 0, 0);
          foundHour = true;
          break;
        }
      }
      if (!foundHour) {
        date.setUTCHours(23, 59, 59, 999);
        date.setUTCDate(date.getUTCDate() + 1);
        date.setUTCHours(0, 0, 0, 0);
      }
      continue;
    }

    // Check minute
    if (!minutes.has(minute)) {
      // Advance to next valid minute
      let foundMinute = false;
      for (let m = minute + 1; m <= 59; m++) {
        if (minutes.has(m)) {
          date.setUTCMinutes(m);
          date.setUTCSeconds(0);
          date.setUTCMilliseconds(0);
          foundMinute = true;
          break;
        }
      }
      if (!foundMinute) {
        // Advance to next hour
        date.setUTCMinutes(59);
        date.setUTCSeconds(59);
        date.setUTCMilliseconds(999);
        date.setUTCHours(date.getUTCHours() + 1);
        date.setUTCMinutes(0);
        date.setUTCSeconds(0);
        date.setUTCMilliseconds(0);
      }
      continue;
    }

    // All fields match
    date.setUTCSeconds(0);
    date.setUTCMilliseconds(0);
    return date.getTime();
  }

  throw new Error(`Cron expression did not resolve within 4 years: ${cron}`);
}
