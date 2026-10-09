/**
 * Inbox row ids (M108 §3.5). Internal — the port receives ids, so a custom
 * store never re-derives them.
 *
 * The marker id is the lowercase hex SHA-256 of
 * `JSON.stringify(['setu-inbox/1', consumer, topic, envelopeId])`: fixed length
 * and alphabet on every backend, whatever the producer sent as an id. The JSON
 * array keeps the hashed input injective (no consumer, topic or id containing
 * a separator can collide with another triple), and `setu-inbox/1` versions
 * the derivation.
 *
 * The topic is part of the key because one consumer name may read several
 * topics: keyed by consumer and id alone, a publisher on topic B could
 * suppress a topic-A event it never saw by reusing its id.
 *
 * @module
 */
import type { InboxIds } from '@setu-ts/common';

/** The version tag hashed into every id. */
const DERIVATION = 'setu-inbox/1';

/** The suffix that turns a marker id into its failure-count row id. */
const ATTEMPTS_SUFFIX = '.attempts';

/** A marker id: 64 lowercase hexadecimal characters. */
const MARKER_ID = /^[0-9a-f]{64}$/;

/** Encodes bytes as lowercase hex. */
function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derives a delivery's two row ids.
 *
 * An ill-formed id (a lone surrogate, reachable only through a `\ud800` JSON
 * escape) is made well-formed first, so it collides with its replacement form
 * — an adversarial-only case, documented.
 *
 * @internal
 * @param subtle - The runtime's `SubtleCrypto`
 * @param consumer - The consumer name
 * @param topic - The subscription topic
 * @param envelopeId - The envelope id, as delivered
 * @returns The marker and failure-count row ids
 */
export async function deriveInboxIds(
  subtle: SubtleCrypto,
  consumer: string,
  topic: string,
  envelopeId: string,
): Promise<InboxIds> {
  const input = JSON.stringify([DERIVATION, consumer, topic, envelopeId.toWellFormed()]);
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(input));
  return idsFromMarker(hex(digest));
}

/**
 * The two row ids for a marker id an operator supplied.
 *
 * @internal
 * @param markerId - A marker id
 * @returns The ids
 */
export function idsFromMarker(markerId: string): InboxIds {
  return { marker: markerId, attempts: `${markerId}${ATTEMPTS_SUFFIX}` };
}

/**
 * Whether a value is a well-formed marker id.
 *
 * @internal
 * @param value - The candidate
 * @returns `true` for 64 lowercase hexadecimal characters
 */
export function isMarkerId(value: unknown): value is string {
  return typeof value === 'string' && MARKER_ID.test(value);
}
