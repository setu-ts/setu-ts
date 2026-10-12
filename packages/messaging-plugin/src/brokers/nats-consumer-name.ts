/**
 * Encodes a `SubscribeOptions.queue` into a JetStream consumer name the nats
 * client accepts (M101b, V8-6).
 *
 * The nats client refuses, before anything reaches the wire, a consumer
 * `name` or `durable_name` containing any of `.`, `*`, `>`, `/`, `\`, space,
 * tab, LF or CR (`minValidation` in nats 2.29's `jetstream/jsutil.js`). The
 * reply inbox subscribes with `rr.inbox.<uuid>`, so every NATS `request()`
 * failed there. Each refused character is escaped as `_` plus two lowercase
 * hex digits (`.` → `_2e`); a name containing none is returned UNCHANGED, so
 * every queue that worked before keeps its consumer.
 *
 * The encoding is not injective on its own: a queue that literally spells an
 * escape (`orders_2eeu`) encodes like the dotted one (`orders.eu`). Escaping
 * `_` as well would rename every underscore queue already deployed, so the
 * broker refuses the collision instead (`NatsConsumerNameCollisionError`).
 *
 * @module
 * @internal
 */

/**
 * The characters the nats client refuses in a consumer name, held as data so
 * the test can iterate the same table.
 *
 * @internal
 */
export const JETSTREAM_FORBIDDEN_NAME_CHARACTERS: readonly string[] = [
  '.',
  '*',
  '>',
  '/',
  '\\',
  ' ',
  '\t',
  '\n',
  '\r',
];

const FORBIDDEN = new Set(JETSTREAM_FORBIDDEN_NAME_CHARACTERS);

/**
 * Encodes a queue name into a legal JetStream consumer name.
 *
 * @param queue - The raw `SubscribeOptions.queue`
 * @returns The queue unchanged when legal, else with each refused character
 *   escaped as `_` + two lowercase hex digits
 * @internal
 */
export function toJetStreamConsumerName(queue: string): string {
  let encoded = '';
  for (const character of queue) {
    encoded += FORBIDDEN.has(character)
      ? `_${character.charCodeAt(0).toString(16).padStart(2, '0')}`
      : character;
  }
  return encoded;
}
