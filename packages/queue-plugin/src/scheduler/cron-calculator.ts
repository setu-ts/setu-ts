/**
 * Zero-dependency cron calculator for recurring jobs.
 *
 * Computes the next fire time for a standard 5-field cron expression.
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

  // Handle step values
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

  // Handle range
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

  // Handle list
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
 * @param cron - The cron expression
 * @param fromMs - The timestamp to compute from (ms since epoch)
 * @returns The next fire time in ms since epoch
 * @throws {Error} If the cron expression is invalid
 *
 * @example
 * ```typescript
 * cronNextMs('* * * * *', Date.now()); // Next minute
 * cronNextMs('0 9 * * 1-5', Date.now()); // 9 AM on weekdays
 * cronNextMs('5 * * * *', Date.now()); // Every hour at :05
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
  const date = new Date(fromMs + 60000); // +1 minute

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
        date.setUTCDate(dayOfMonth + 1);
        date.setUTCHours(0, 0, 0, 0);
        continue;
      }
    } else {
      // AND semantics: fire if both match (or one is *)
      if (!domMatch || !dowMatch) {
        date.setUTCDate(dayOfMonth + 1);
        date.setUTCHours(0, 0, 0, 0);
        continue;
      }
    }

    // Check hour
    if (!hours.has(hour)) {
      date.setUTCHours(hour + 1);
      date.setUTCMinutes(0, 0, 0);
      continue;
    }

    // Check minute
    if (!minutes.has(minute)) {
      // Find next valid minute in current hour
      let foundMinute = false;
      for (const m of minutes) {
        if (m > minute) {
          date.setUTCMinutes(m);
          date.setUTCSeconds(0, 0);
          foundMinute = true;
          break;
        }
      }
      if (!foundMinute) {
        date.setUTCHours(hour + 1);
        date.setUTCMinutes(0, 0, 0);
      }
      continue;
    }

    // Found a valid time
    date.setUTCSeconds(0, 0);
    return date.getTime();
  }

  throw new Error('Could not compute next fire time within 4 years');
}
