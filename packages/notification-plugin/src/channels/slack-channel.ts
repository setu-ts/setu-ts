/**
 * SlackChannel — extracts channel name and dispatches via `SlackTransport`.
 *
 * @module
 */

import type { NotificationMessage } from '@setu-ts/common';
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
   * Sends the notification as text, optionally including `to.channel`. A
   * non-empty `subject` leads the text in bold (`*subject*`, then the body on
   * the next line), escaped as Slack requires so it cannot inject a mention or
   * a link; the body is passed as given.
   *
   * @param notification - The notification to send
   * @throws {Error} If transport rejects
   */
  async send(notification: NotificationMessage): Promise<void> {
    // Honor exactOptionalPropertyTypes — build without `channel` when absent.
    // An empty `to.channel` counts as absent (a config default that resolved to
    // ''): Slack rejects `channel: ""`, whereas omitting it posts to the
    // webhook's default channel. Matches the truthiness check the other channels
    // apply to their own address key.
    const channel = notification.to.channel;
    const subject = notification.subject;
    const text =
      subject === undefined || subject === ''
        ? notification.body
        : `*${escapeSlackText(subject)}*\n${notification.body}`;
    const message: SlackMessage = channel ? { text, channel } : { text };
    await this.transport.send(message);
  }
}

/**
 * Escapes the three characters Slack's message formatting reserves, so the text
 * renders literally (`<!channel>` would otherwise ping the channel).
 *
 * @param text - Text to escape
 * @returns The escaped text
 */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
