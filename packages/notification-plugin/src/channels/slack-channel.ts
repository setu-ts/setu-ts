/**
 * SlackChannel — extracts channel name and dispatches via `SlackTransport`.
 *
 * @module
 */

import type { NotificationMessage } from '@hono-enterprise/common';
import type { NotificationChannel, SlackMessage, SlackTransport } from '../interfaces/index.ts';

/**
 * `SlackChannel` dispatches notifications through a `SlackTransport` (e.g. `SlackProvider`).
 *
 * @param name - The channel dispatch name
 * @param transport - The injected `SlackTransport`
 * @since 0.1.0
 */
export class SlackChannel implements NotificationChannel {
  readonly name: string;
  private readonly transport: SlackTransport;

  constructor(name: string, transport: SlackTransport) {
    this.name = name;
    this.transport = transport;
  }

  /**
   * Sends the body as text, optionally including `to.channel`.
   *
   * @param notification - The notification to send
   * @throws {Error} If transport rejects
   */
  async send(notification: NotificationMessage): Promise<void> {
    // Honor exactOptionalPropertyTypes — build without `channel` when absent.
    const channel = notification.to.channel;
    const message: SlackMessage = channel === undefined
      ? { text: notification.body }
      : { text: notification.body, channel };
    await this.transport.send(message);
  }
}
