/**
 * Normalizes native transport header values to the string record the
 * {@linkcode MessageMetadata.headers} contract declares.
 *
 * Three transports hand back values that are not strings. AMQP field tables
 * carry numbers, booleans, timestamps, byte arrays and nested tables; Service
 * Bus application properties are typed `number | boolean | string | Date |
 * null`; Kafka delivers `Buffer` values and permits arrays. Asserting any of
 * those into `Readonly<Record<string, string>>` is a type lie that reaches a
 * subscriber as a runtime surprise, so every first-party broker funnels its
 * inbound headers through here.
 *
 * A value that has no faithful string form — a nested table, an array of
 * tables, `null`, or a byte value that is not valid UTF-8 — is DROPPED rather
 * than rendered as `[object Object]` or as U+FFFD replacement characters. A
 * missing header is readable as absent, while a corrupted one is not.
 *
 * @module
 */

/** A value an AMQP, Service Bus or Kafka header channel can deliver. @internal */
export type TransportHeaderValue =
  | string
  | number
  | boolean
  | Date
  | Uint8Array
  | null
  | undefined
  | readonly unknown[]
  | Record<string, unknown>;

// `fatal: true` so malformed bytes REJECT rather than decoding to U+FFFD.
// The lenient default synthesizes replacement characters the producer never
// sent, which is a value with no faithful string form — exactly what this
// module drops. Reuse across a throw is safe: non-streaming `decode()` is
// stateless (probed).
const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Converts one native header value to its string form.
 *
 * @param value - The raw value the transport delivered
 * @returns The string form, or `undefined` when the value has no faithful one
 */
function toHeaderString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  // `Buffer` extends `Uint8Array`, so this covers amqplib and kafkajs alike.
  if (value instanceof Uint8Array) {
    try {
      return decoder.decode(value);
    } catch {
      // Catching here is mandatory, not defensive: the Kafka path runs inside
      // `eachMessage`, where an escaping throw prevents the offset commit and
      // the broker redelivers the record forever.
      return undefined;
    }
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return String(value);
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? undefined : value.toISOString();
  }
  return undefined;
}

/**
 * Normalizes a native transport header table to a string record.
 *
 * @param headers - The raw header table, or `undefined` when the transport carried none
 * @returns Every value that has a faithful string form, keyed as delivered
 * @internal
 */
export function normalizeTransportHeaders(
  headers: Readonly<Record<string, TransportHeaderValue>> | undefined,
): Readonly<Record<string, string>> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).flatMap(([key, value]) => {
      // Kafka's `IHeaders` permits an array per key; the wire carries one
      // trace context, so the first element is the propagated value.
      const candidate = Array.isArray(value) ? value[0] : value;
      const text = toHeaderString(candidate);
      return text === undefined ? [] : [[key, text] as const];
    }),
  );
}
