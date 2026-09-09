/**
 * W3C `traceFlags` normalization, shared by the two places that read a raw
 * OTel span context: the span wrapper in `telemetry-service.ts` and the active
 * span read in `tracer.ts`.
 *
 * Extracted rather than copied because the two must agree byte-for-byte — a
 * `trace_id` enriched onto a log record and the same span's `traceparent`
 * written onto a job have to be the same string for the join this exists for
 * to work at all.
 *
 * @module
 */

/**
 * Normalizes `traceFlags` to a 2-character lowercase hex string, honoring the
 * `SpanContext.traceFlags: string` contract.
 *
 * OTel's own `SpanContext.traceFlags` is a `number` (e.g. `1` for sampled), so
 * numeric values are converted to the W3C-required 2-hex form (`"01"`) and
 * short strings are padded (`"1"` → `"01"`).
 *
 * @param flags - The raw value read off an OTel span context
 * @returns A 2-character lowercase hex string; `'00'` for anything unreadable
 * @internal
 */
export function normalizeTraceFlags(flags: unknown): string {
  if (typeof flags === 'number') {
    return flags.toString(16).padStart(2, '0');
  }
  if (typeof flags === 'string') {
    return flags.toLowerCase().padStart(2, '0');
  }
  return '00';
}
