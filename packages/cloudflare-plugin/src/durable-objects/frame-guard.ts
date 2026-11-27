/**
 * Wire validation for the Durable Object realtime backplane.
 * @module
 */
import type { RealtimeFrame } from '@setu-ts/common';

/**
 * Refuses malformed or foreign traffic on the shared namespace.
 * @param value - The decoded socket message
 * @returns Whether required and optional frame fields have their wire types
 */
export function isRealtimeFrame(value: unknown): value is RealtimeFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  if (frame['kind'] !== 'ws-room' && frame['kind'] !== 'sse-channel') return false;
  if (typeof frame['origin'] !== 'string') return false;
  if (typeof frame['name'] !== 'string') return false;
  if (typeof frame['data'] !== 'string') return false;
  if (frame['binary'] !== undefined && typeof frame['binary'] !== 'boolean') return false;
  if (frame['exceptId'] !== undefined && typeof frame['exceptId'] !== 'string') return false;
  const exceptIds = frame['exceptIds'];
  if (exceptIds !== undefined && !isStringArray(exceptIds)) return false;
  return true;
}

/** Whether `value` is an array of strings only. */
function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
