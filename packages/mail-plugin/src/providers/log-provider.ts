/**
 * LogProvider — the zero-dependency default backend. It never sends a real
 * email: each message is recorded in memory, forwarded to an optional `sink`,
 * and logged via the resolved {@linkcode ILogger}. Works on every runtime
 * (including Cloudflare Workers); intended for testing and local development.
 *
 * @module
 */
import type { ILogger, MailProvider, OutgoingMail } from '../interfaces/index.ts';

/**
 * Options for {@linkcode LogProvider}.
 *
 * @since 0.1.0
 */
export interface LogProviderOptions {
  /** Logger to write each send to (typically `ctx.logger`). */
  logger?: ILogger;
  /** Called with each sent message — a read-back seam for tests/hooks. */
  sink?: (message: OutgoingMail) => void;
}

/**
 * Records outgoing mail instead of sending it.
 *
 * @since 0.1.0
 */
export class LogProvider implements MailProvider {
  readonly #logger: ILogger | undefined;
  readonly #sink: ((message: OutgoingMail) => void) | undefined;
  readonly #messages: OutgoingMail[] = [];
  #ready = false;

  /**
   * @param options - Logger and read-back sink
   */
  constructor(options?: LogProviderOptions) {
    this.#logger = options?.logger;
    this.#sink = options?.sink;
  }

  /** Every message recorded by this provider, in send order. */
  get messages(): readonly OutgoingMail[] {
    return this.#messages;
  }

  connect(): Promise<void> {
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
   * Records and logs a message.
   *
   * @param message - The outgoing mail
   */
  send(message: OutgoingMail): Promise<void> {
    this.#messages.push(message);
    this.#sink?.(message);
    this.#logger?.info('mail sent (log provider)', {
      from: message.from,
      to: Array.isArray(message.to) ? message.to.join(', ') : message.to,
      subject: message.subject,
    });
    return Promise.resolve();
  }
}
