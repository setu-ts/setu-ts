/**
 * The responder side of brokered request-reply: posting a reply to the caller's
 * inbox object.
 *
 * @module
 * @since 0.2.0
 */

import type { LoggerSource } from '../background/wait-until.ts';
import type { IDurableObjectNamespace } from '../bindings/facades.ts';
import type { ReplyEnvelope } from './message-envelope.ts';

/** The synthetic URL the stub is fetched with. Only the path is meaningful. */
const DELIVER_URL = 'https://reply-inbox.internal/deliver';

/**
 * Delivers one reply to the inbox object the request named.
 *
 * **Never throws.** A responder runs inside a queue-consumer invocation whose
 * message must still be acked: letting a delivery failure escape would turn one
 * unreachable caller into a redelivered request, which re-runs the responder —
 * so a handler with a side effect would repeat it every retry until the queue
 * dead-lettered the message. The caller's own timeout is the correct outcome
 * for an undeliverable reply, and it already exists.
 *
 * @param namespace - The Durable Object namespace serving reply inboxes
 * @param replyTo - The inbox address from the request envelope
 * @param reply - The reply to deliver
 * @param logger - Logger accessor for reporting a failed delivery
 * @returns Resolves once the delivery has been attempted
 * @since 0.2.0
 */
export async function deliverReply(
  namespace: IDurableObjectNamespace,
  replyTo: string,
  reply: ReplyEnvelope,
  logger?: LoggerSource,
): Promise<void> {
  try {
    const stub = namespace.get(namespace.idFromName(replyTo));
    const response = await stub.fetch(DELIVER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reply),
    });

    if (!response.ok) {
      logger?.()?.warn('cloudflare-messaging: reply inbox refused a delivery', {
        replyTo,
        correlationId: reply.correlationId,
        status: response.status,
      });
    }
  } catch (error: unknown) {
    logger?.()?.warn('cloudflare-messaging: reply delivery failed', {
      replyTo,
      correlationId: reply.correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
