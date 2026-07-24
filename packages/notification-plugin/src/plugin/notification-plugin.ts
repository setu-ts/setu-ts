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
} from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type {
  ChannelConfig,
  ChannelsMap,
  FcmProviderOptions,
  INotificationHttp,
  NotificationPluginOptions,
  ProviderType,
  SlackProviderOptions,
  TwilioProviderOptions,
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

// Re-exported at the top level of each provider for test assertion.
export { FcmProvider, SlackProvider, TwilioProvider };

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
 *     sms: { provider: 'twilio', options: { accountSid: '…', authToken: '…', from: '+1234' } },
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
    optionalDependencies: [CAPABILITIES.MAIL, CAPABILITIES.LOGGER],
    provides: [CAPABILITIES.NOTIFICATION],
    priority: PLUGIN_PRIORITY.NORMAL,

    register(ctx: IPluginContext): void {
      const channelMap = new Map<string, import('../interfaces/index.ts').NotificationChannel>();

      for (const [name, config] of Object.entries(channels)) {
        const channel = createChannel(name, config, ctx);
        channelMap.set(name, channel);
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
 * Resolves the provider via {@linkcode createProvider}, then wraps it in the
 * appropriate channel class (`EmailChannel`, `SmsChannel`, `PushChannel`, or `SlackChannel`).
 *
 * @param name - The channel dispatch name
 * @param config - The channel configuration
 * @param ctx - The plugin context
 * @returns The configured channel
 * @throws {Error} If the provider type is unsupported or `email` is used without MailPlugin
 * @since 0.1.0
 */
export function createChannel(
  name: string,
  config: ChannelConfig,
  ctx: IPluginContext,
): import('../interfaces/index.ts').NotificationChannel {
  const provider = createProvider(config.provider, config.options ?? {}, ctx);

  switch (config.provider) {
    case 'mail':
      return new EmailChannel(name, provider as unknown as IMailer);
    case 'twilio': {
      const smsTransport = provider as import('../interfaces/index.ts').SmsTransport;
      return new SmsChannel(name, smsTransport);
    }
    case 'fcm': {
      const pushTransport = provider as import('../interfaces/index.ts').PushTransport;
      return new PushChannel(name, pushTransport);
    }
    case 'slack': {
      const slackTransport = provider as import('../interfaces/index.ts').SlackTransport;
      return new SlackChannel(name, slackTransport);
    }
    default:
      throw new Error(`Unsupported notification provider: ${config.provider as string}`);
  }
}

/**
 * Creates a transport provider for the given type.
 *
 * For `'mail'`, resolves `IMailer` from the context service registry. For
 * `'twilio'`, `'fcm'`, and `'slack'`, returns the corresponding HTTP-based provider.
 *
 * @param type - The provider type
 * @param options - Provider-specific options
 * @param ctx - The plugin context (for resolving `IMailer` when `type === 'mail'`)
 * @returns The transport provider
 * @throws {Error} If the provider type is unsupported, required options are missing, or `email` is configured without MailPlugin
 * @since 0.1.0
 */
export function createProvider(
  type: ProviderType,
  options: Readonly<Record<string, unknown>>,
  ctx?: IPluginContext,
): unknown {
  switch (type) {
    case 'mail': {
      if (!ctx) {
        throw new Error(
          'Notification "email" channel requires the mail capability (CAPABILITIES.MAIL); register MailPlugin (M29) or remove the email channel',
        );
      }
      const mailer = ctx.services.get<IMailer>(CAPABILITIES.MAIL);
      if (!mailer) {
        throw new Error(
          'Notification "email" channel requires the mail capability (CAPABILITIES.MAIL); register MailPlugin (M29) or remove the email channel',
        );
      }
      return mailer;
    }
    case 'twilio': {
      const twilioOpts = options as unknown as TwilioProviderOptions;
      const http = (twilioOpts as { http?: INotificationHttp }).http;
      const result: TwilioProviderOptions = {
        accountSid: twilioOpts.accountSid,
        authToken: twilioOpts.authToken,
        from: twilioOpts.from,
      };
      if (http !== undefined) {
        result.http = http;
      }
      return new TwilioProvider(result);
    }
    case 'fcm': {
      const fcmOpts = options as unknown as FcmProviderOptions;
      const http = (fcmOpts as { http?: INotificationHttp }).http;
      const result: FcmProviderOptions = { serverKey: fcmOpts.serverKey };
      if (http !== undefined) {
        result.http = http;
      }
      return new FcmProvider(result);
    }
    case 'slack': {
      const slackOpts = options as unknown as SlackProviderOptions;
      const http = (slackOpts as { http?: INotificationHttp }).http;
      const result: SlackProviderOptions = { webhookUrl: slackOpts.webhookUrl };
      if (http !== undefined) {
        result.http = http;
      }
      return new SlackProvider(result);
    }
    default:
      throw new Error(`Unsupported notification provider: ${type as string}`);
  }
}
