/**
 * Response builder — chainable configuration + terminal methods that produce
 * the opaque {@linkcode HandlerResult} brand only the kernel creates.
 *
 * @module
 */
import type { HandlerResult, IResponse } from '@hono-enterprise/common';

/** Opaque brand — only the kernel constructs values of this type. */
const HANDLER_RESULT: HandlerResult = { __handlerResult: true };

/**
 * Default implementation of {@linkcode IResponse}. Configuration methods
 * chain; terminal methods mark the builder as ended and return the brand.
 */
export class ResponseBuilder implements IResponse {
  #status = 200;
  readonly #headers = new Headers();
  #body: Uint8Array | string | null = null;
  #ended = false;

  status(code: number): IResponse {
    this.#status = code;
    return this;
  }

  header(name: string, value: string): IResponse {
    this.#headers.set(name, value);
    return this;
  }

  json<T>(body: T): HandlerResult {
    this.#body = JSON.stringify(body);
    this.#headers.set('content-type', 'application/json; charset=utf-8');
    this.#ended = true;
    return HANDLER_RESULT;
  }

  text(body: string): HandlerResult {
    this.#body = body;
    this.#headers.set('content-type', 'text/plain; charset=utf-8');
    this.#ended = true;
    return HANDLER_RESULT;
  }

  send(body?: Uint8Array): HandlerResult {
    this.#body = body ?? null;
    if (body !== undefined && !this.#headers.has('content-type')) {
      this.#headers.set('content-type', 'application/octet-stream');
    }
    this.#ended = true;
    return HANDLER_RESULT;
  }

  redirect(url: string, status: number = 302): HandlerResult {
    this.#status = status;
    this.#headers.set('location', url);
    this.#body = null;
    this.#ended = true;
    return HANDLER_RESULT;
  }

  /**
   * Returns a snapshot of the current response state.
   *
   * @returns The status code, headers, and body
   */
  snapshot(): { status: number; headers: Headers; body: Uint8Array | string | null } {
    return {
      status: this.#status,
      headers: this.#headers,
      body: this.#body,
    };
  }

  /** Whether a terminal method has been called (used to detect short-circuits). */
  get ended(): boolean {
    return this.#ended;
  }
}
