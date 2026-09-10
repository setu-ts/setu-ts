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
} from '@setu-ts/common';
import {
  CAPABILITIES,
  createCachedProbe,
  PLUGIN_PRIORITY,
  resolveProbeTiming,
} from '@setu-ts/common';
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
import denoJson from '../../deno.json' with { type: 'json' };

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
 * import { NotificationPlugin } from '@setu-ts/notification-plugin';
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
    version: denoJson.version,
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

      // H-70c-4: this indicator hardcoded `status: 'up'` beside a live channel
      // list, so a configured channel whose transport was down was invisible.
      // It now reports each channel's reachability, and a channel that was
      // CONTACTED and did not answer takes the whole indicator `down`.
      //
      // Most channels report `'unknown'`, and that is the honest answer rather
      // than a gap: a probe may not deliver a notification, and this package's
      // send-only transports expose no alternative — see
      // `NotificationChannel.isHealthy`. `'unknown'` never reads as healthy,
      // which is the whole point of carrying it instead of assuming `true`.
      const probes = buildChannelProbes(channelMap, ctx);

      ctx.health.register('notification', async (): Promise<HealthCheckResult> => {
        const reachability: Record<string, boolean | 'unknown'> = {};
        let anyUnreachable = false;

        // CONCURRENTLY, and that is a correctness requirement rather than a
        // speed one. Each probe may consume its full `PROBE_TIMEOUT_MS`, and
        // `HealthPluginOptions.indicatorTimeoutMs` defaults to 5000 (M90b),
        // so awaiting them one after another means three stalled channels —
        // an ordinary configuration, since channel names are arbitrary and
        // several may address the same transport — blow the indicator's own
        // deadline. The whole indicator would then be replaced by a generic
        // `{ reason: 'timeout' }`, discarding the per-channel evidence this
        // payload exists to carry. Started together, total latency is bounded
        // by ONE probe timeout however many channels there are.
        const names = Array.from(channelMap.keys());
        const outcomes = await Promise.all(names.map((name) => {
          const probe = probes.get(name);
          return probe === undefined ? Promise.resolve(undefined) : probe();
        }));

        // Assembled in channel-map order, so the payload's key order does not
        // depend on which probe settled first.
        names.forEach((name, index) => {
          const reachable = outcomes[index];
          reachability[name] = reachable ?? 'unknown';
          if (reachable === false) {
            anyUnreachable = true;
          }
        });

        return {
          status: anyUnreachable ? 'down' : 'up',
          data: { channels: Array.from(channelMap.keys()), reachable: reachability },
        };
      });
    },
  };
}

/**
 * Builds one cached, bounded reachability probe per channel that offers one.
 *
 * Constructed once at registration, never per request: each probe coalesces
 * concurrent health callers into a single in-flight call, caches the outcome
 * for a TTL, and bounds the call with a timeout, so scraping `/health` can
 * never turn into transport load. The TTL runs on the runtime's monotonic
 * clock and the timeout on the runtime's timers, both injected — there is no
 * ambient-clock path.
 *
 * A channel with no `isHealthy` gets no entry, so the indicator reports it
 * `'unknown'` without calling anything.
 *
 * @param channels - The registered channels, by dispatch name
 * @param ctx - Plugin context, for runtime clock and timers
 * @returns Probes by channel name, omitting channels that cannot be probed
 * @since 0.6.0
 */
function buildChannelProbes(
  channels: ReadonlyMap<string, NotificationChannel>,
  ctx: IPluginContext,
): Map<string, () => Promise<boolean | undefined>> {
  const timing = resolveProbeTiming(ctx.runtime);
  const probes = new Map<string, () => Promise<boolean | undefined>>();

  for (const [name, channel] of channels) {
    const isHealthy = channel.isHealthy;
    if (typeof isHealthy !== 'function') {
      continue;
    }
    probes.set(
      name,
      createCachedProbe<boolean | undefined>({
        // Bound call: a channel's `isHealthy` reads its own transport, so it
        // must be invoked on its owner.
        probe: () => isHealthy.call(channel),
        // A probe that times out or rejects means the transport was reached
        // for and did not answer — `false`, not `undefined`. `undefined` is
        // reserved for "the question could not be asked at all", which the
        // channel itself reports by resolving `undefined`.
        fallback: false,
        ttlMs: PROBE_TTL_MS,
        timeoutMs: PROBE_TIMEOUT_MS,
        hrtime: timing.hrtime,
        setTimer: timing.setTimer,
        clearTimer: timing.clearTimer,
      }),
    );
  }

  return probes;
}

/** Reachability outcome cache lifetime, in milliseconds. */
const PROBE_TTL_MS = 5000;

/** Per-probe timeout, in milliseconds. A slower probe counts as unreachable. */
const PROBE_TIMEOUT_MS = 2000;

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
