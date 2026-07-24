/**
 * SendGridProvider — sends via the SendGrid v3 HTTP API over web-standard
 * `fetch` (no SDK, Cloudflare Workers-compatible). The API key is sent as a
 * Bearer token.
 *
 * @module
 */
import type { IMailHttp, MailProvider, OutgoingMail } from '../interfaces/index.ts';

/** Default SendGrid v3 send endpoint. */
const DEFAULT_ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';

/** Lowest non-successful HTTP status. */
const HTTP_MULTIPLE_CHOICES = 300;

/**
 * Options for {@linkcode SendGridProvider}.
 *
 * @since 0.1.0
 */
export interface SendGridProviderOptions {
  /** SendGrid API key sent as a Bearer token. */
  apiKey?: string | undefined;
  /** API endpoint. Default `https://api.sendgrid.com/v3/mail/send`. */
  endpoint?: string | undefined;
  /** Injected `fetch`-shaped function; defaults to global `fetch`. */
  http?: IMailHttp | undefined;
}

/** Maps an {@linkcode OutgoingMail} to a SendGrid v3 request body. */
export function toSendGridBody(message: OutgoingMail): Record<string, unknown> {
  const toAddresses = Array.isArray(message.to) ? message.to : [message.to as string];
  const personalization: Record<string, unknown> = {
    to: toAddresses.map((email) => ({ email })),
  };
  if (message.cc !== undefined) {
    personalization.cc = message.cc.map((email) => ({ email }));
  }
  if (message.bcc !== undefined) {
    personalization.bcc = message.bcc.map((email) => ({ email }));
  }
  const content: Array<{ type: string; value: string }> = [];
  if (message.text !== undefined) {
    content.push({ type: 'text/plain', value: message.text });
  }
  if (message.html !== undefined) {
    content.push({ type: 'text/html', value: message.html });
  }
  return {
    personalizations: [personalization],
    from: { email: message.from },
    subject: message.subject,
    content,
  };
}

/**
 * SendGrid provider over `fetch`.
 *
 * @since 0.1.0
 */
export class SendGridProvider implements MailProvider {
  readonly #endpoint: string;
  readonly #http: IMailHttp;
  readonly #apiKey: string;
  #ready = false;

  /**
   * @param options - SendGrid connection/injection options
   */
  constructor(options?: SendGridProviderOptions) {
    this.#endpoint = options?.endpoint ?? DEFAULT_ENDPOINT;
    this.#apiKey = options?.apiKey ?? '';
    this.#http = options?.http ?? ((url, init): Promise<Response> => fetch(url, init));
  }

  connect(): Promise<void> {
    if (this.#apiKey === '') {
      return Promise.reject(new Error('SendGridProvider requires options.apiKey'));
    }
    this.#ready = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.#ready = false;
    return Promise.resolve();
  }

  isReady(): boolean {
    return this.#ready;
  }

  /**
   * Sends a message via the SendGrid v3 API.
   *
   * @param message - The outgoing mail
   * @throws {Error} On any non-2xx HTTP response
   */
  async send(message: OutgoingMail): Promise<void> {
    const res = await this.#http(this.#endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.#apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(toSendGridBody(message)),
    });
    if (res.status >= HTTP_MULTIPLE_CHOICES) {
      throw new Error(`SendGrid send failed: HTTP ${res.status}`);
    }
  }
}
