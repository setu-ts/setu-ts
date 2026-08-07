/**
 * Internal ports and option types for the notification plugin.
 *
 * Transport ports (implemented by providers), the injectable HTTP seam,
 * and plugin configuration shapes. These are NOT exported from `@setu-ts/common`
 * — they live inside the package so the channel/provider split remains encapsulated.
 *
 * @module
 */

import type { IMailer, IRuntimeServices, NotificationMessage } from '@setu-ts/common';

/**
 * Supplies OAuth2 access tokens for FCM HTTP v1.
 *
 * Implemented internally by a service-account signer. Supply your own through
 * {@linkcode FcmProviderOptions.tokenSource} to source tokens differently — for
 * example from a GCP metadata server, or from a workload-identity broker that
 * holds the private key outside the application.
 *
 * @since 0.1.0
 */
export interface FcmTokenSource {
  /**
   * Returns a valid access token, minting or refreshing one as needed.
   *
   * @returns The bearer token to present to FCM
   * @throws {Error} If a token cannot be obtained
   */
  getAccessToken(): Promise<string>;
}

// ── NotificationChannel port (internal) ──────────────────────────────────────

/**
 * Internal port shared by all notification channel implementations.
 *
 * Not exported as a concrete type — only the implementations (EmailChannel,
 * SmsChannel, etc.) are exported; consumers use the INotifier contract.
 *
 * @since 0.1.0
 */
export interface NotificationChannel {
  /** Channel dispatch name (e.g. `'email'`, `'sms'`). */
  readonly name: string;
  /**
   * Sends a notification through this channel.
   *
   * @param notification - The notification to send
   * @throws {Error} If the channel fails to deliver
   */
  send(notification: NotificationMessage): Promise<void>;
}

// ── Transport ports ──────────────────────────────────────────────────────────

/**
 * SMS transport port implemented by {@linkcode TwilioProvider}.
 *
 * @since 0.1.0
 */
export interface SmsTransport {
  /**
   * Sends an SMS message.
   *
   * @param message - The SMS message
   * @throws {Error} If delivery fails
   */
  send(message: SmsMessage): Promise<void>;
}

/**
 * An outgoing SMS message shaped by {@linkcode SmsTransport}.
 *
 * @since 0.1.0
 */
export interface SmsMessage {
  readonly to: string;
  readonly body: string;
}

/**
 * Push-notification transport port implemented by {@linkcode FcmProvider}.
 *
 * @since 0.1.0
 */
export interface PushTransport {
  /**
   * Sends a push notification.
   *
   * @param message - The push notification
   * @throws {Error} If delivery fails
   */
  send(message: PushMessage): Promise<void>;
}

/**
 * An outgoing push-notification message shaped by {@linkcode PushTransport}.
 *
 * @since 0.1.0
 */
export interface PushMessage {
  readonly to: string;
  readonly title?: string;
  readonly body: string;
}

/**
 * Slack transport port implemented by {@linkcode SlackProvider}.
 *
 * @since 0.1.0
 */
export interface SlackTransport {
  /**
   * Posts a Slack message.
   *
   * @param message - The Slack message
   * @throws {Error} If posting fails
   */
  send(message: SlackMessage): Promise<void>;
}

/**
 * An outgoing Slack message shaped by {@linkcode SlackTransport}.
 *
 * @since 0.1.0
 */
export interface SlackMessage {
  readonly text: string;
  readonly channel?: string;
}

// ── HTTP seam ────────────────────────────────────────────────────────────────

/**
 * Response shape returned by {@linkcode INotificationHttp.post}.
 *
 * @since 0.1.0
 */
export interface NotificationHttpResponse {
  ok: boolean;
  status: number;
  text: string;
}

/**
 * Injectable HTTP seam for notification providers.
 *
 * Providers call `post(url, body, headers)` to issue their HTTP request.
 * The default implementation (`createDefaultNotificationHttp`) delegates to
 * web-standard `fetch`.
 *
 * @since 0.1.0
 */
export interface INotificationHttp {
  /**
   * Issues a POST request and returns a mapped response.
   *
   * @param url - The target URL
   * @param body - The serialized body string
   * @param headers - Headers to include
   * @returns The mapped response
   * @throws {Error} When the request fails
   */
  post(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<NotificationHttpResponse>;
}

// ── Plugin options ───────────────────────────────────────────────────────────

/**
 * Email channel configuration.
 *
 * Carries no `options`: transport is delegated to the `IMailer` resolved from
 * `CAPABILITIES.MAIL`, which MailPlugin (M29) configures.
 *
 * @since 0.1.0
 */
export interface MailChannelConfig {
  readonly provider: 'mail';
}

/**
 * SMS channel configuration — `options` are {@linkcode TwilioProviderOptions}.
 *
 * @since 0.1.0
 */
export interface TwilioChannelConfig {
  readonly provider: 'twilio';
  readonly options: TwilioProviderOptions;
}

/**
 * Push channel configuration — `options` are {@linkcode FcmProviderOptions}.
 *
 * @since 0.1.0
 */
export interface FcmChannelConfig {
  readonly provider: 'fcm';
  readonly options: FcmProviderOptions;
}

/**
 * Slack channel configuration — `options` are {@linkcode SlackProviderOptions}.
 *
 * @since 0.1.0
 */
export interface SlackChannelConfig {
  readonly provider: 'slack';
  readonly options: SlackProviderOptions;
}

/**
 * Per-channel configuration, discriminated on `provider`.
 *
 * Each arm names the exact options its provider consumes, so a missing or
 * misspelled credential is a compile error rather than a startup throw.
 *
 * @since 0.1.0
 */
export type ChannelConfig =
  | MailChannelConfig
  | TwilioChannelConfig
  | FcmChannelConfig
  | SlackChannelConfig;

/**
 * Provider type selector — the `ChannelConfig` discriminant.
 *
 * Derived from the union so it cannot drift out of sync with the arms.
 *
 * @since 0.1.0
 */
export type ProviderType = ChannelConfig['provider'];

/**
 * Plugin-level channels map.
 *
 * @since 0.1.0
 */
export type ChannelsMap = Readonly<Record<string, ChannelConfig>>;

/**
 * Union of every transport a channel can be built on, as returned by
 * `createProvider`.
 *
 * @since 0.1.0
 */
export type NotificationTransport = IMailer | SmsTransport | PushTransport | SlackTransport;

/**
 * Options for {@linkcode NotificationPlugin}.
 *
 * @since 0.1.0
 */
export interface NotificationPluginOptions {
  /** Channel definitions keyed by dispatch name. */
  channels: ChannelsMap;
}

// ── Provider options ─────────────────────────────────────────────────────────

/**
 * Options for {@linkcode TwilioProvider}.
 *
 * @since 0.1.0
 */
export interface TwilioProviderOptions {
  accountSid: string;
  authToken: string;
  from: string;
  http?: INotificationHttp;
}

/**
 * Options for {@linkcode FcmProvider}.
 *
 * @since 0.1.0
 */
export interface FcmProviderOptions {
  /** Firebase project id; addressed by the v1 `messages:send` URL. */
  projectId: string;
  /**
   * Service-account email that signs the OAuth2 assertion. Required unless
   * {@linkcode tokenSource} is supplied.
   */
  clientEmail?: string;
  /**
   * PEM PKCS#8 private key for the service account. Required unless
   * {@linkcode tokenSource} is supplied.
   */
  privateKey?: string;
  /**
   * Runtime services providing Web Crypto and the wall clock, used to sign the
   * assertion and expire cached tokens. Required unless {@linkcode tokenSource}
   * is supplied; the plugin passes this automatically.
   */
  runtime?: IRuntimeServices;
  /**
   * Overrides how access tokens are acquired — e.g. from a GCP metadata server
   * instead of a locally held key. When set, the three credential fields above
   * are unused.
   */
  tokenSource?: FcmTokenSource;
  http?: INotificationHttp;
}

/**
 * Options for {@linkcode SlackProvider}.
 *
 * @since 0.1.0
 */
export interface SlackProviderOptions {
  webhookUrl: string;
  http?: INotificationHttp;
}
