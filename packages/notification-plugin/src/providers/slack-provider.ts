/**
 * SlackProvider — Slack incoming webhook over web-standard `fetch`.
 *
 * @module
 */

import { createDefaultNotificationHttp } from '../http/default-http.ts';
import type { INotificationHttp } from '../interfaces/index.ts';
import type { SlackMessage, SlackProviderOptions, SlackTransport } from '../interfaces/index.ts';

/**
 * `SlackProvider` implements `SlackTransport` via a Slack incoming webhook URL.
 *
 * @since 0.1.0
 */
export class SlackProvider implements SlackTransport {
  private readonly webhookUrl: string;
  private readonly http: INotificationHttp;

  /**
   * Creates a `SlackProvider`.
   *
   * @param options - Provider configuration
   * @throws {Error} If `webhookUrl` is missing
   */
  constructor(options: SlackProviderOptions) {
    if (!options.webhookUrl) {
      throw new Error('SlackProvider requires "webhookUrl"');
    }
    this.webhookUrl = options.webhookUrl;
    this.http = options.http ?? createDefaultNotificationHttp();
  }

  /**
   * Posts a message to the Slack webhook.
   *
   * Slack signals success only when HTTP 200 AND body is the literal `"ok"` —
   * a compound check: `!response.ok` **and** `response.text !== 'ok'` each
   * constitute failure arms.
   *
   * @param message - The Slack message
   * @throws {Error} If the response fails either the OK flag or the body check
   */
  async send(message: SlackMessage): Promise<void> {
    const payload: { text: string; channel?: string } = { text: message.text };
    if (message.channel !== undefined) {
      payload.channel = message.channel;
    }
    const body = JSON.stringify(payload);
    const response = await this.http.post(this.webhookUrl, body, {
      'Content-Type': 'application/json',
    });
    if (!response.ok || response.text !== 'ok') {
      const reason = !response.ok
        ? `Slack webhook error (${response.status})`
        : `Slack webhook error (unexpected response: ${response.text})`;
      throw new Error(reason);
    }
  }
}
