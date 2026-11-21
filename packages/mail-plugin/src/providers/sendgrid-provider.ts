/**
 * SendGridProvider — sends via the SendGrid v3 HTTP API over web-standard
 * `fetch` (no SDK, Cloudflare Workers-compatible). The API key is sent as a
 * Bearer token.
 *
 * @module
 */
import type { DeadlineOptions } from '@setu-ts/common';
import type { IMailHttp, MailProvider, OutgoingMail } from '../interfaces/index.ts';
import { toBase64 } from './encoding.ts';
import type { MailDeadline } from './bounded-send.ts';
import { resolveMailDeadline, runMailCall, toMailError } from './bounded-send.ts';

/** The longest piece of SendGrid's own error text copied into a failure message. */
const MAX_REASON = 200;

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
  /**
   * Bound on one send (and on the readiness probe), in milliseconds; the
   * request's signal is aborted when it expires. A send that does not settle in
   * time rejects with `BackendOutcomeUnknownError` (`504`): the message may
   * have gone out. `0` disables the bound; anything outside `0`–`2147483647`
   * throws `RangeError` at construction.
   *
   * @default 15000
   * @since 0.14.0
   */
  requestTimeoutMs?: number | undefined;
  /**
   * Timer surface the bound runs on. `MailPlugin` supplies the runtime's
   * timers; a directly constructed provider falls back to the ambient ones.
   *
   * @since 0.14.0
   */
  timing?: DeadlineOptions['timing'];
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
    ...(message.attachments === undefined
      ? {}
      : {
          attachments: message.attachments.map((attachment) => ({
            content: toBase64(attachment.content),
            filename: attachment.filename,
            disposition: attachment.contentId === undefined ? 'attachment' : 'inline',
            ...(attachment.contentType === undefined ? {} : { type: attachment.contentType }),
            ...(attachment.contentId === undefined ? {} : { content_id: attachment.contentId }),
          })),
        }),
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
  readonly #scopesUrl: string;
  readonly #deadline: MailDeadline;
  #ready = false;

  /**
   * @param options - SendGrid connection/injection options
   * @throws {RangeError} When `requestTimeoutMs` is out of range
   */
  constructor(options?: SendGridProviderOptions) {
    this.#deadline = resolveMailDeadline(options?.requestTimeoutMs, options?.timing);
    this.#endpoint = options?.endpoint ?? DEFAULT_ENDPOINT;
    this.#apiKey = options?.apiKey ?? '';
    this.#http = options?.http ?? ((url, init): Promise<Response> => fetch(url, init));
    // The scopes endpoint shares the API's origin and version prefix with the
    // send endpoint (…/v3/mail/send → …/v3/scopes).
    this.#scopesUrl = this.#endpoint.replace(/\/mail\/send$/, '/scopes');
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
   * M70c: a `GET /v3/scopes` through the existing `IMailHttp` seam. 2xx means
   * the key is valid; 401 means the API reached us (so the backend is
   * reachable even though the key is wrong); any other status or a network
   * failure means unreachable.
   *
   * @returns `true` when the SendGrid API is reachable
   * @since 0.1.0
   */
  async isHealthy(): Promise<boolean> {
    try {
      const status = await runMailCall(this.#deadline, 'sendgrid', async (signal) => {
        const res = await this.#http(this.#scopesUrl, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.#apiKey}` },
          signal,
        });
        await res.body?.cancel().catch(() => undefined);
        return res.status;
      });
      return status < HTTP_MULTIPLE_CHOICES || status === 401;
    } catch {
      return false;
    }
  }

  /**
   * Sends a message via the SendGrid v3 API.
   *
   * @param message - The outgoing mail
   * @throws {Error} If the provider is not connected, or on any non-2xx HTTP
   *   response (the message names the status and SendGrid's own first error)
   * @throws {BackendOutcomeUnknownError} When the send does not settle within
   *   `requestTimeoutMs`
   */
  async send(message: OutgoingMail): Promise<void> {
    // Without this a send after `app.stop()` still POSTed a real email.
    if (!this.#ready) {
      throw new Error('SendGridProvider is not connected');
    }
    // One bound covers the send and the refusal's error text. The status is
    // SendGrid's answer, so a refusal whose text is slow is still a refusal:
    // when the bound expires during the text, the refusal is reported without
    // it, and the aborted signal releases the connection.
    let refusedWith: number | undefined;
    let reason = '';
    try {
      await runMailCall(this.#deadline, 'sendgrid', async (signal) => {
        const res = await this.#http(this.#endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(toSendGridBody(message)),
          signal,
        });
        if (res.status < HTTP_MULTIPLE_CHOICES) {
          await res.body?.cancel().catch(() => undefined);
          return;
        }
        refusedWith = res.status;
        reason = await sendGridReason(res);
      });
    } catch (error) {
      if (refusedWith === undefined) throw toMailError(error, 'sendgrid');
    }
    if (refusedWith !== undefined) {
      throw new Error(
        `SendGrid send failed: HTTP ${refusedWith}${reason === '' ? '' : `: ${reason}`}`,
      );
    }
  }
}

/**
 * Reads SendGrid's own reason from an error response: the first
 * `errors[].message` of its JSON body, cut to {@linkcode MAX_REASON}
 * characters, or `''` when the body carries none. For the log only — the
 * response a caller sees stays a masked `500`.
 *
 * @param res - The non-2xx response
 * @returns The reason, or `''`
 */
export async function sendGridReason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { errors?: readonly { message?: unknown }[] };
    const message = body.errors?.[0]?.message;
    // Control characters (CR/LF included) are replaced, so the text cannot
    // forge a log line.
    return typeof message === 'string'
      ? // eslint-disable-next-line no-control-regex -- control characters are what it replaces
        message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_REASON)
      : '';
  } catch {
    return '';
  }
}
