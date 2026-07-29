/**
 * `NotificationPlugin` — registers an `INotifier` under `CAPABILITIES.NOTIFICATION`.
 *
 * @module
 */

import type {
  HealthCheckResult,
  IMailer,
  INotifier,
  IPlugin,
  IPluginContext,
  IRuntimeServices,
} from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type {
  ChannelConfig,
  ChannelsMap,
  FcmChannelConfig,
  MailChannelConfig,
  NotificationChannel,
  NotificationPluginOptions,
  NotificationTransport,
  PushTransport,
  SlackChannelConfig,
  SlackTransport,
  SmsTransport,
  TwilioChannelConfig,
} from '../interfaces/index.ts';
import { NotificationService } from '../services/notification-service.ts';
import { EmailChannel } from '../channels/email-channel.ts';
import { SmsChannel } from '../channels/sms-channel.ts';
import { PushChannel } from '../channels/push-channel.ts';
import { SlackChannel } from '../channels/slack-channel.ts';
import { TwilioProvider } from '../providers/twilio-provider.ts';
import { FcmProvider } from '../providers/fcm-provider.ts';
import { SlackProvider } from '../providers/slack-provider.ts';

/** Plugin name. */
const PLUGIN_NAME = 'notification-plugin';

/**
 * Creates the plugin factory.
 *
 * Registers an {@linkcode INotifier} under `CAPABILITIES.NOTIFICATION` backed by the
 * configured channels and providers.
 *
 * @example
 * ```typescript
 * import { NotificationPlugin } from '@hono-enterprise/notification-plugin';
 *
 * app.register(NotificationPlugin({
 *   channels: {
 *     email: { provider: 'mail' },
 *     sms: {
 *       provider: 'twilio',
 *       options: { accountSid: '…', authToken: '…', from: '+1234' },
 *     },
 *     slack: { provider: 'slack', options: { webhookUrl: 'https://hooks.slack.com/…' } },
 *   },
 * }));
 * ```
 * @param options - Plugin configuration
 * @returns The plugin instance
 * @since 0.1.0
 */
export function NotificationPlugin(options: NotificationPluginOptions): IPlugin {
  const channels: ChannelsMap = options.channels;

  return {
    name: PLUGIN_NAME,
    version: '0.1.0',
    optionalDependencies: [CAPABILITIES.MAIL],
    provides: [CAPABILITIES.NOTIFICATION],
    priority: PLUGIN_PRIORITY.NORMAL,

    register(ctx: IPluginContext): void {
      const channelMap = new Map<string, NotificationChannel>();

      for (const [name, config] of Object.entries(channels)) {
        channelMap.set(name, createChannel(name, config, ctx));
      }

      const service = new NotificationService(channelMap);
      ctx.services.register<INotifier>(CAPABILITIES.NOTIFICATION, service);

      ctx.health.register('notification', (): Promise<HealthCheckResult> =>
        Promise.resolve({
          status: 'up',
          data: { channels: Array.from(channelMap.keys()) },
        }));
    },
  };
}

/**
 * Creates a `NotificationChannel` for the given channel entry.
 *
 * Resolves the transport via {@linkcode createProvider}, then wraps it in the
 * matching channel class (`EmailChannel`, `SmsChannel`, `PushChannel`, or `SlackChannel`).
 *
 * @param name - The channel dispatch name
 * @param config - The channel configuration
 * @param ctx - The plugin context (required for `'mail'`, which resolves `IMailer`)
 * @returns The configured channel
 * @throws {Error} If the provider type is unsupported or `mail` is used without MailPlugin
 * @since 0.1.0
 */
export function createChannel(
  name: string,
  config: ChannelConfig,
  ctx?: IPluginContext,
): NotificationChannel {
  switch (config.provider) {
    case 'mail':
      return new EmailChannel(name, createProvider(config, ctx));
    case 'twilio':
      return new SmsChannel(name, createProvider(config));
    case 'fcm':
      return new PushChannel(name, createProvider(config, ctx));
    case 'slack':
      return new SlackChannel(name, createProvider(config));
    default:
      // Unreachable for a type-checked config; guards JS callers and bad casts.
      throw new Error(
        `Unsupported notification provider: ${(config as ChannelConfig).provider as string}`,
      );
  }
}

/**
 * Creates the transport for a channel configuration.
 *
 * For `'mail'`, resolves `IMailer` from the context service registry. For
 * `'twilio'`, `'fcm'`, and `'slack'`, constructs the corresponding HTTP provider
 * from the config's `options`, which each provider validates.
 *
 * The overloads bind each config arm to the transport port it produces, so a
 * caller never has to narrow or cast the result.
 *
 * @param config - The channel configuration
 * @param ctx - The plugin context (for resolving `IMailer` when `provider` is `'mail'`)
 * @returns The transport for this configuration
 * @throws {Error} If the provider type is unsupported, required options are missing, or `mail` is configured without MailPlugin
 * @since 0.1.0
 */
export function createProvider(config: MailChannelConfig, ctx?: IPluginContext): IMailer;
export function createProvider(config: TwilioChannelConfig): SmsTransport;
export function createProvider(config: FcmChannelConfig, ctx?: IPluginContext): PushTransport;
export function createProvider(config: SlackChannelConfig): SlackTransport;
export function createProvider(
  config: ChannelConfig,
  ctx?: IPluginContext,
): NotificationTransport;
export function createProvider(
  config: ChannelConfig,
  ctx?: IPluginContext,
): NotificationTransport {
  switch (config.provider) {
    case 'mail': {
      if (!ctx || !ctx.services.has(CAPABILITIES.MAIL)) {
        throw new Error(
          'Notification "email" channel requires the mail capability (CAPABILITIES.MAIL); register MailPlugin (M29) or remove the email channel',
        );
      }
      return ctx.services.get<IMailer>(CAPABILITIES.MAIL);
    }
    case 'twilio':
      return new TwilioProvider(config.options);
    case 'fcm': {
      // A caller-supplied tokenSource carries its own credentials, so the
      // runtime is only needed for the default service-account signer.
      if (config.options.tokenSource === undefined) {
        if (!ctx || !ctx.services.has(CAPABILITIES.RUNTIME)) {
          throw new Error(
            'Notification "push" channel requires the runtime capability (CAPABILITIES.RUNTIME) to sign FCM service-account tokens; register RuntimePlugin, or supply an explicit "tokenSource"',
          );
        }
        return new FcmProvider({
          ...config.options,
          runtime: ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME),
        });
      }
      return new FcmProvider(config.options);
    }
    case 'slack':
      return new SlackProvider(config.options);
    default:
      // Unreachable for a type-checked config; guards JS callers and bad casts.
      throw new Error(
        `Unsupported notification provider: ${(config as ChannelConfig).provider as string}`,
      );
  }
}
