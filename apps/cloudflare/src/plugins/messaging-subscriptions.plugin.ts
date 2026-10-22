import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker, IPlugin } from '@setu-ts/common';
import type { ICloudflareBindings } from '@setu-ts/cloudflare-plugin';
import { AUDIT_TOPIC, BINDINGS, DOUBLE_TOPIC, LAST_AUDIT_KEY } from '../bindings.ts';

/**
 * Registers the subscriber and responder the Worker's `queue` export dispatches to.
 *
 * Cloudflare delivers queue messages to a separate invocation from the `fetch`
 * that published them, so these must exist before the first delivery. The
 * subscriber writes to KV so that delivery is observable from outside.
 */
export function MessagingSubscriptionsPlugin(): IPlugin {
  return {
    name: 'messaging-subscriptions',
    version: '0.0.0',
    dependencies: ['cloudflare-plugin'],
    async register(ctx): Promise<void> {
      const broker = ctx.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      const bindings = ctx.services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE);

      await broker.subscribe<{ note: string }>(AUDIT_TOPIC, async (message) => {
        await bindings.kv(BINDINGS.kv).put(LAST_AUDIT_KEY, message.note);
      });
      await broker.respond<number, number>(DOUBLE_TOPIC, (n) => n * 2);
    },
  };
}
