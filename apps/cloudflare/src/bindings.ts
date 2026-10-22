/** Binding names, as declared in `wrangler.toml`. */
export const BINDINGS = {
  kv: 'EXAMPLE_KV',
  queue: 'MESSAGES',
  replyInbox: 'REPLY_INBOX',
} as const;

/** The topic the audit route publishes on and the subscriber listens to. */
export const AUDIT_TOPIC = 'audit.logged';

/** The brokered request/reply topic. */
export const DOUBLE_TOPIC = 'double';

/** The KV key the audit subscriber writes the latest note to. */
export const LAST_AUDIT_KEY = 'last-audit';
