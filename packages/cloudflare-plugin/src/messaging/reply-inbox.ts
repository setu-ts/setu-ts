/**
 * The replica side of the reply inbox: the socket a caller holds open while it
 * awaits a reply.
 *
 * Deliberately simpler than {@linkcode DurableObjectBackplane}, which opens a
 * comparable socket, and the difference is a lifecycle one rather than an
 * oversight. The backplane's socket carries a long-lived subscription, so it
 * reconnects after a drop and guards a generation counter against a close
 * landing mid-open. An inbox socket exists only for as long as requests are in
 * flight: if it drops, every pending request is already doomed and must fail
 * rather than silently wait for a reply that can no longer be routed.
 *
 * @module
 * @since 0.2.0
 */

import type { IDurableObjectNamespace } from '../bindings/facades.ts';
import type {
  DurableObjectMessageEvent,
  IDurableObjectClientSocket,
} from '../durable-objects/do-facades.ts';
import { asUpgradeResponse } from '../durable-objects/do-facades.ts';

/** Prefix for the per-instance Durable Object names inboxes are addressed by. */
const INBOX_PREFIX = 'rr.inbox.';

/** The synthetic URL the stub is fetched with. Only the path is meaningful. */
const CONNECT_URL = 'https://reply-inbox.internal/connect';

/** What {@linkcode openReplyInbox} needs from its caller. */
export interface ReplyInboxDeps {
  /** The Durable Object namespace serving reply inboxes. */
  readonly namespace: IDurableObjectNamespace;
  /** The namespace's binding name, for error messages. */
  readonly binding: string;
  /** Address source (the broker's `runtime.uuid`). */
  uuid(): string;
  /** Invoked per raw payload arriving on the socket. */
  onReply(raw: string): void;
  /** Invoked when the socket drops while requests may still be in flight. */
  onClosed(): void;
}

/**
 * An open reply inbox: the address responders deliver to, plus its teardown.
 *
 * @since 0.2.0
 */
export interface ReplyInbox {
  /**
   * The Durable Object name a responder delivers replies to. Travels to the
   * responder as the `replyTo` field of each request envelope.
   */
  readonly address: string;
  /**
   * Closes the socket and releases the object.
   */
  close(): Promise<void>;
}

/**
 * Opens a per-instance reply inbox by upgrading a Durable Object stub.
 *
 * @param deps - The namespace, an address source, and the arrival callbacks
 * @returns The open inbox
 * @throws {CloudflareUnsupportedError} When the object answers the upgrade with
 * no `webSocket` member — a namespace bound to a class that is not a reply
 * inbox
 * @example
 * ```typescript
 * const inbox = await openReplyInbox({
 *   namespace, binding: 'REPLY_INBOX',
 *   uuid: () => runtime.uuid(),
 *   onReply: (raw) => settle(raw),
 *   onClosed: () => correlation.rejectAll(new Error('inbox closed')),
 * });
 * ```
 * @since 0.2.0
 */
export async function openReplyInbox(deps: ReplyInboxDeps): Promise<ReplyInbox> {
  // Unique per open, so two isolates never share an inbox object and a reply
  // can only reach the caller that asked for it.
  const address = `${INBOX_PREFIX}${deps.uuid()}`;
  const stub = deps.namespace.get(deps.namespace.idFromName(address));

  const response = await stub.fetch(CONNECT_URL, { headers: { Upgrade: 'websocket' } });
  const socket = asUpgradeResponse(response, deps.binding).webSocket;
  socket.accept();

  let closed = false;
  const drop = (): void => {
    if (closed) return;
    closed = true;
    deps.onClosed();
  };

  socket.addEventListener('message', (event: DurableObjectMessageEvent) => {
    if (typeof event.data !== 'string') return;
    deps.onReply(event.data);
  });
  socket.addEventListener('close', drop);
  socket.addEventListener('error', drop);

  return {
    address,
    close: (): Promise<void> => {
      // Marked closed BEFORE the close call, so the `close` event this triggers
      // does not re-enter `onClosed` and reject requests the caller is
      // deliberately tearing down.
      closed = true;
      closeQuietly(socket);
      return Promise.resolve();
    },
  };
}

/**
 * Closes a socket without letting a failure escape.
 *
 * @param socket - The socket to close
 */
function closeQuietly(socket: IDurableObjectClientSocket): void {
  try {
    socket.close(1000, 'reply inbox closed');
  } catch {
    // Already closed, or closing — either way there is nothing left to clean up
    // and no caller to inform.
    return;
  }
}
