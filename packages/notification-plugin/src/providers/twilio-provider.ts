/**
 * TwilioProvider — Twilio REST API over web-standard `fetch`.
 *
 * @module
 */

import { createDefaultNotificationHttp } from '../http/default-http.ts';
import type {
  INotificationHttp,
  SmsMessage,
  SmsTransport,
  TwilioProviderOptions,
} from '../interfaces/index.ts';

/**
 * `TwilioProvider` implements `SmsTransport` via the Twilio Accounts SID / Messages endpoint.
 *
 * @since 0.1.0
 */
export class TwilioProvider implements SmsTransport {
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly from: string;
  private readonly http: INotificationHttp;

  /**
   * Creates a `TwilioProvider`.
   *
   * @param options - Provider configuration
   * @throws {Error} If `accountSid`, `authToken`, or `from` is missing
   */
  constructor(options: TwilioProviderOptions) {
    if (!options.accountSid) {
      throw new Error('TwilioProvider requires "accountSid"');
    }
    if (!options.authToken) {
      throw new Error('TwilioProvider requires "authToken"');
    }
    if (!options.from) {
      throw new Error('TwilioProvider requires "from"');
    }
    this.accountSid = options.accountSid;
    this.authToken = options.authToken;
    this.from = options.from;
    this.http = options.http ?? createDefaultNotificationHttp();
  }

  /**
   * Sends an SMS via the Twilio REST API.
   *
   * @param message - The SMS message
   * @throws {Error} If the response is not OK
   */
  async send(message: SmsMessage): Promise<void> {
    const auth = btoa(`${this.accountSid}:${this.authToken}`);
    const body = new URLSearchParams({
      To: message.to,
      From: this.from,
      Body: message.body,
    }).toString();
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const response = await this.http.post(url, body, {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    if (!response.ok) {
      throw new Error(`Twilio API error (${response.status}): ${response.text}`);
    }
  }
}
