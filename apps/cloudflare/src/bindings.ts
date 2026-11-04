import { serviceToken } from '@setu-ts/common';
import type { CloudflareWorkerEnv } from '@setu-ts/cloudflare-plugin';

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

/** The invocation environment, registered per application before startup. */
export const WORKER_ENV = serviceToken<CloudflareWorkerEnv>('example.worker-env');
