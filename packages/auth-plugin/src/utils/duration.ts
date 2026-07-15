/**
 * Duration parsing utility for JWT expiresIn.
 *
 * @module
 */

/**
 * Parse a duration string to milliseconds.
 *
 * Supports formats like "30s", "5m", "1h", "7d", or bare integer seconds.
 *
 * @param value - Duration string or seconds number
 * @returns Duration in milliseconds
 * @throws {Error} If the value cannot be parsed
 *
 * @example
 * ```typescript
 * parseDuration('30s') // 30000
 * parseDuration('5m')  // 300000
 * parseDuration('1h')  // 3600000
 * parseDuration('7d')  // 604800000
 * parseDuration(60)    // 60000
 * ```
 */
export function parseDuration(value: string | number): number {
  if (typeof value === 'number') {
    // Bare integer is treated as seconds
    return value * 1000;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    throw new Error('Duration cannot be empty');
  }

  // Try to parse as bare integer (seconds)
  const bareInt = parseInt(trimmed, 10);
  if (!isNaN(bareInt) && bareInt.toString() === trimmed) {
    return bareInt * 1000;
  }

  // Parse with unit suffix
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([smhd])$/);
  if (!match) {
    throw new Error(
      `Invalid duration format: "${value}". Use formats like "30s", "5m", "1h", "7d", or bare seconds.`,
    );
  }

  const amount = parseFloat(match[1]);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
  };

  const seconds = amount * multipliers[unit];
  return Math.round(seconds * 1000);
}
