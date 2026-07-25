/**
 * FcmProvider — FCM legacy server-key API over web-standard `fetch`.
 *
 * @module
 */

import { createDefaultNotificationHttp } from '../http/default-http.ts';
import type { INotificationHttp } from '../interfaces/index.ts';
import type { FcmProviderOptions, PushMessage, PushTransport } from '../interfaces/index.ts';

/**
 * `FcmProvider` implements `PushTransport` via the legacy FCM HTTP API.
 *
 * @since 0.1.0
 */
export class FcmProvider implements PushTransport {
  private readonly serverKey: string;
  private readonly http: INotificationHttp;

  /**
   * Creates an `FcmProvider`.
   *
   * @param options - Provider configuration
   * @throws {Error} If `serverKey` is missing
   */
  constructor(options: FcmProviderOptions) {
    if (!options.serverKey) {
      throw new Error('FcmProvider requires "serverKey"');
    }
    this.serverKey = options.serverKey;
    this.http = options.http ?? createDefaultNotificationHttp();
  }

  /**
   * Sends a push notification via the legacy FCM endpoint.
   *
   * @param message - The push notification message
   * @throws {Error} If the response is not OK
   */
  async send(message: PushMessage): Promise<void> {
    const payload: Record<string, unknown> = { to: message.to };
    if (message.title !== undefined) {
      payload.notification = { title: message.title, body: message.body };
    } else {
      payload.notification = { body: message.body };
    }
    const body = JSON.stringify(payload);
    const response = await this.http.post(
      'https://fcm.googleapis.com/fcm/send',
      body,
      {
        Authorization: `key=${this.serverKey}`,
        'Content-Type': 'application/json',
      },
    );
    if (!response.ok) {
      throw new Error(`FCM API error (${response.status}): ${response.text}`);
    }
  }
}
