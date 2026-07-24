/**
 * Internal ports and option types for the notification plugin.
 *
 * Transport ports (implemented by providers), the injectable HTTP seam,
 * and plugin configuration shapes. These are NOT exported from `@hono-enterprise/common`
 * — they live inside the package so the channel/provider split remains encapsulated.
 *
 * @module
 */

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
  send(notification: import('@hono-enterprise/common').NotificationMessage): Promise<void>;
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
 * Provider type selector.
 *
 * @since 0.1.0
 */
export type ProviderType = 'mail' | 'twilio' | 'fcm' | 'slack';

/**
 * Per-channel configuration.
 *
 * @since 0.1.0
 */
export interface ChannelConfig {
  /** Provider type that selects the transport. */
  provider: ProviderType;
  /** Provider-specific options (ignored for `'mail'`). */
  options?: Readonly<Record<string, unknown>>;
}

/**
 * Plugin-level channels map.
 *
 * @since 0.1.0
 */
export type ChannelsMap = Readonly<Record<string, ChannelConfig>>;

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
  serverKey: string;
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
