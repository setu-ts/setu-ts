/**
 * @module
 *
 * Multi-channel notification plugin: email, SMS, push, Slack.
 *
 * Provides `NotificationPlugin` (factory), `NotificationService` (the `INotifier`
 * implementation), channel factories (`createChannel`), provider factories (`createProvider`),
 * four channel classes (`EmailChannel`, `SmsChannel`, `PushChannel`, `SlackChannel`),
 * three HTTP providers (`TwilioProvider`, `FcmProvider`, `SlackProvider`), the shared
 * `INotificationHttp` seam plus its fetch-backed default (`createDefaultNotificationHttp`),
 * and all option/type shapes.
 *
 * The plugin registers an `INotifier` under `CAPABILITIES.NOTIFICATION`.
 *
 * @since 0.1.0
 */

// ── Plugin factory ──────────────────────────────────────────────────────────

/**
 * NotificationPlugin factory — registers an {@linkcode INotifier} under `CAPABILITIES.NOTIFICATION`.
 *
 * @example
 * ```typescript
 * import { NotificationPlugin } from '@setu-ts/notification-plugin';
 *
 * app.register(NotificationPlugin({
 *   channels: {
 *     email: { provider: 'mail' },
 *     sms: { provider: 'twilio', options: { accountSid: '…', authToken: '…', from: '+1234' } },
 *   },
 * }));
 * ```
 * @since 0.1.0
 */
export { createChannel, createProvider, NotificationPlugin } from './plugin/notification-plugin.ts';

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * `NotificationService` — the {@linkcode INotifier} implementation with parallel fan-out and `AggregateError`.
 *
 * @since 0.1.0
 */
export { NotificationService } from './services/notification-service.ts';

// ── Channels ────────────────────────────────────────────────────────────────

/**
 * `EmailChannel` — dispatches through a resolved `IMailer`.
 *
 * @since 0.1.0
 */
export { EmailChannel } from './channels/email-channel.ts';

/**
 * `SmsChannel` — dispatches through an `SmsTransport` (e.g. `TwilioProvider`).
 *
 * @since 0.1.0
 */
export { SmsChannel } from './channels/sms-channel.ts';

/**
 * `PushChannel` — dispatches through a `PushTransport` (e.g. `FcmProvider`).
 *
 * @since 0.1.0
 */
export { PushChannel } from './channels/push-channel.ts';

/**
 * `SlackChannel` — dispatches through a `SlackTransport` (e.g. `SlackProvider`).
 *
 * @since 0.1.0
 */
export { SlackChannel } from './channels/slack-channel.ts';

// ── Providers (transports) ──────────────────────────────────────────────────

/**
 * `TwilioProvider` — `SmsTransport` over the Twilio REST API.
 *
 * @since 0.1.0
 */
export { TwilioProvider } from './providers/twilio-provider.ts';

/**
 * `FcmProvider` — `PushTransport` over the FCM HTTP v1 API, authenticated with
 * a service-account OAuth2 token.
 *
 * @since 0.1.0
 */
export { FcmProvider } from './providers/fcm-provider.ts';

/**
 * `FcmTokenSource` — supplies OAuth2 access tokens to {@linkcode FcmProvider}.
 * Implement it to source tokens somewhere other than a locally held
 * service-account key.
 *
 * @since 0.1.0
 */
export type { FcmTokenSource } from './interfaces/index.ts';

/**
 * `SlackProvider` — `SlackTransport` over a Slack incoming webhook.
 *
 * @since 0.1.0
 */
export { SlackProvider } from './providers/slack-provider.ts';

// ── HTTP seam ───────────────────────────────────────────────────────────────

/**
 * Creates the default fetch-backed {@linkcode INotificationHttp}.
 *
 * @since 0.1.0
 */
export { createDefaultNotificationHttp } from './http/default-http.ts';

// ── Option / type exports ───────────────────────────────────────────────────

/** Options for {@linkcode NotificationPlugin}. */
export type { NotificationPluginOptions } from './interfaces/index.ts';

/** Per-channel configuration — a union discriminated on `provider`. */
export type { ChannelConfig } from './interfaces/index.ts';

/** The four `ChannelConfig` arms, one per provider type. */
export type {
  FcmChannelConfig,
  MailChannelConfig,
  SlackChannelConfig,
  TwilioChannelConfig,
} from './interfaces/index.ts';

/** Provider type selector. */
export type { ProviderType } from './interfaces/index.ts';

/** Channels map for {@linkcode NotificationPluginOptions}. */
export type { ChannelsMap } from './interfaces/index.ts';

/** Union of every transport `createProvider` can return. */
export type { NotificationTransport } from './interfaces/index.ts';

/** Options for {@linkcode TwilioProvider}. */
export type { TwilioProviderOptions } from './interfaces/index.ts';

/** Options for {@linkcode FcmProvider}. */
export type { FcmProviderOptions } from './interfaces/index.ts';

/** Options for {@linkcode SlackProvider}. */
export type { SlackProviderOptions } from './interfaces/index.ts';

/** Injectable HTTP seam for notification providers. */
export type { INotificationHttp } from './interfaces/index.ts';

/** HTTP response shape for {@linkcode INotificationHttp}. */
export type { NotificationHttpResponse } from './interfaces/index.ts';

/** SMS transport port implemented by {@linkcode TwilioProvider}. */
export type { SmsTransport } from './interfaces/index.ts';

/** Outgoing SMS message shaped by {@linkcode SmsTransport}. */
export type { SmsMessage } from './interfaces/index.ts';

/** Push-notification transport port implemented by {@linkcode FcmProvider}. */
export type { PushTransport } from './interfaces/index.ts';

/** Outgoing push-notification message shaped by {@linkcode PushTransport}. */
export type { PushMessage } from './interfaces/index.ts';

/** Slack transport port implemented by {@linkcode SlackProvider}. */
export type { SlackTransport } from './interfaces/index.ts';

/** Outgoing Slack message shaped by {@linkcode SlackTransport}. */
export type { SlackMessage } from './interfaces/index.ts';

// ── Re-exported from @setu-ts/common ────────────────────────────────

/** The committed notification contract (`send`) and message shape. */
export type { INotifier, NotificationMessage } from '@setu-ts/common';
