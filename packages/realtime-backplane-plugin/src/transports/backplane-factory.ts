/**
 * Builds the configured transport from the plugin's discriminated options.
 *
 * @module
 * @since 0.2.0
 */

import type {
  IMessageBroker,
  IRealtimeBackplane,
  IRealtimeHandlerErrorReporter,
  IServiceRegistry,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import type { RealtimeBackplanePluginOptions } from '../interfaces/index.ts';
import { DEFAULT_TOPIC } from '../interfaces/index.ts';
import { MemoryBackplane } from './memory-backplane.ts';
import { MessagingBackplane } from './messaging-backplane.ts';
import { RedisBackplane } from './redis-backplane.ts';

/**
 * Creates the transport named by `options.transport`.
 *
 * @param options - The plugin options
 * @param services - Registry used to resolve `CAPABILITIES.MESSAGING` for the
 * `'messaging'` arm
 * @param origin - This instance's identity, used when no `origin` is configured
 * @param reporter - Optional subscriber failure and recovery sink
 * @returns The transport
 * @throws {Error} When the `'messaging'` arm is selected with no messaging
 * capability registered, or when the transport discriminant is unrecognized
 * @since 0.2.0
 */
export function createBackplane(
  options: RealtimeBackplanePluginOptions,
  services: IServiceRegistry,
  origin: string,
  reporter?: IRealtimeHandlerErrorReporter,
): IRealtimeBackplane {
  if (options.transport === 'custom') {
    return options.instance;
  }

  const topic = options.topic ?? DEFAULT_TOPIC;
  const resolvedOrigin = options.origin ?? origin;

  switch (options.transport) {
    case 'messaging': {
      if (!services.has(CAPABILITIES.MESSAGING)) {
        throw new Error(
          "realtime-backplane: transport 'messaging' requires a plugin providing " +
            `'${CAPABILITIES.MESSAGING}'. Register MessagingPlugin, or choose the ` +
            "'redis' or 'memory' transport.",
        );
      }
      const broker = services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      return new MessagingBackplane(broker, resolvedOrigin, topic, reporter);
    }

    case 'redis': {
      return new RedisBackplane(options, resolvedOrigin, topic, reporter);
    }

    case 'memory':
    case undefined: {
      return new MemoryBackplane(resolvedOrigin, options.bus, reporter);
    }

    default:
      throw new Error(
        'realtime-backplane: unrecognized transport ' +
          `${(options as { transport: string }).transport}`,
      );
  }
}
