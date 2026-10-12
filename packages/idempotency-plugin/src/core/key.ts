/**
 * Client-key normalization (plan §3.6).
 *
 * @module
 */
import { MAX_CLIENT_KEY_CHARS } from '../constants.ts';

/**
 * Normalizes a raw client key.
 *
 * Strips one pair of surrounding double quotes when present (draft-07 §2.1; no
 * escape processing), then requires the result to be 1–255 characters, each in
 * `0x21`–`0x7E` and not `"`.
 *
 * @param raw - The raw header or field value
 * @returns The normalized key, or `undefined` when it is not usable
 */
export function parseKeyValue(raw: string): string | undefined {
  let value = raw;
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  if (value.length < 1 || value.length > MAX_CLIENT_KEY_CHARS) return undefined;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return undefined;
  }
  if (value.includes('"')) return undefined;
  return value;
}
