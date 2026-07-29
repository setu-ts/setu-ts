/**
 * FcmProvider — Firebase Cloud Messaging HTTP v1 over web-standard `fetch`.
 *
 * @module
 */

import { createDefaultNotificationHttp } from '../http/default-http.ts';
import type { INotificationHttp } from '../interfaces/index.ts';
import type { FcmProviderOptions, PushMessage, PushTransport } from '../interfaces/index.ts';
import type { FcmTokenSource } from '../interfaces/index.ts';
import { ServiceAccountTokenSource } from './token-source.ts';

/** FCM HTTP v1 project namespace; the project id and method are appended. */
const FCM_V1_ENDPOINT = 'https://fcm.googleapis.com/v1/projects';

/**
 * `FcmProvider` implements `PushTransport` via the FCM HTTP v1 API.
 *
 * Authenticates with a short-lived OAuth2 bearer token minted from a service
 * account (see {@linkcode FcmTokenSource}), replacing the legacy `serverKey`
 * API that Google decommissioned in 2024.
 *
 * @example
 * ```typescript
 * const provider = new FcmProvider({
 *   projectId: 'my-firebase-project',
 *   clientEmail: 'fcm@my-project.iam.gserviceaccount.com',
 *   privateKey: config.get('FCM_PRIVATE_KEY'),
 *   runtime,
 * });
 * await provider.send({ to: deviceToken, title: 'Hello', body: 'World' });
 * ```
 * @since 0.1.0
 */
export class FcmProvider implements PushTransport {
  readonly #projectId: string;
  readonly #http: INotificationHttp;
  readonly #tokenSource: FcmTokenSource;

  /**
   * Creates an `FcmProvider`.
   *
   * @param options - Provider configuration
   * @throws {Error} If `projectId` is missing, or — when no `tokenSource` is
   * supplied — if `clientEmail`, `privateKey`, or `runtime` is missing
   */
  constructor(options: FcmProviderOptions) {
    if (!options.projectId) {
      throw new Error('FcmProvider requires "projectId"');
    }
    this.#projectId = options.projectId;
    this.#http = options.http ?? createDefaultNotificationHttp();

    if (options.tokenSource !== undefined) {
      this.#tokenSource = options.tokenSource;
    } else {
      // Everything the default signer needs is validated here rather than at
      // first send, so a misconfigured channel fails while the app is starting.
      if (!options.clientEmail) {
        throw new Error('FcmProvider requires "clientEmail" (or an explicit "tokenSource")');
      }
      if (!options.privateKey) {
        throw new Error('FcmProvider requires "privateKey" (or an explicit "tokenSource")');
      }
      if (!options.runtime) {
        throw new Error('FcmProvider requires "runtime" (or an explicit "tokenSource")');
      }
      this.#tokenSource = new ServiceAccountTokenSource({
        clientEmail: options.clientEmail,
        privateKey: options.privateKey,
        runtime: options.runtime,
        http: this.#http,
      });
    }
  }

  /**
   * Sends a push notification via the FCM HTTP v1 endpoint.
   *
   * @param message - The push notification message
   * @throws {Error} If a token cannot be obtained, or the response is not OK
   * @since 0.1.0
   */
  async send(message: PushMessage): Promise<void> {
    const token = await this.#tokenSource.getAccessToken();

    const notification: Record<string, unknown> = { body: message.body };
    if (message.title !== undefined) {
      notification.title = message.title;
    }
    const body = JSON.stringify({
      message: { token: message.to, notification },
    });

    const response = await this.#http.post(
      `${FCM_V1_ENDPOINT}/${this.#projectId}/messages:send`,
      body,
      {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    );
    if (!response.ok) {
      throw new Error(`FCM API error (${response.status}): ${response.text}`);
    }
  }
}
