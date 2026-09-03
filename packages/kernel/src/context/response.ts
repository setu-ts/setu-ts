/**
 * Response builder — chainable configuration + terminal methods that produce
 * the opaque {@linkcode HandlerResult} brand only the kernel creates.
 *
 * @module
 */
import type {
  HandlerResult,
  IResponse,
  ResponseSnapshot,
  ResponseSnapshotInit,
} from '@setu-ts/common';

/** Opaque brand — only the kernel constructs values of this type. */
const HANDLER_RESULT: HandlerResult = { __handlerResult: true };

/** Internal immutable header sources for the common terminal response shapes. */
const JSON_INIT = responseInit({ 'content-type': 'application/json; charset=utf-8' });
const TEXT_INIT = responseInit({ 'content-type': 'text/plain; charset=utf-8' });
const HTML_INIT = responseInit({ 'content-type': 'text/html; charset=utf-8' });
const BINARY_INIT = responseInit({ 'content-type': 'application/octet-stream' });

/**
 * Default implementation of {@linkcode IResponse}. Configuration methods
 * chain; terminal methods mark the builder as ended and return the brand.
 */
export class ResponseBuilder implements IResponse {
  #status = 200;
  #headers: Headers | undefined;
  #responseInit: TerminalResponseInit | undefined;
  #initHeaderName: string | undefined;
  #body: Uint8Array | string | ReadableStream<Uint8Array> | null = null;
  #streaming = false;
  #ended = false;

  status(code: number): IResponse {
    this.#status = code;
    return this;
  }

  header(name: string, value: string): IResponse {
    this.#materializeHeaders().set(name, value);
    return this;
  }

  appendHeader(name: string, value: string): IResponse {
    this.#materializeHeaders().append(name, value);
    return this;
  }

  json<T>(body: T): HandlerResult {
    this.#body = JSON.stringify(body);
    this.#setBuiltInHeader('content-type', 'application/json; charset=utf-8', JSON_INIT);
    this.#ended = true;
    return HANDLER_RESULT;
  }

  text(body: string): HandlerResult {
    this.#body = body;
    this.#setBuiltInHeader('content-type', 'text/plain; charset=utf-8', TEXT_INIT);
    this.#ended = true;
    return HANDLER_RESULT;
  }

  /**
   * Sends an HTML response with the `text/html; charset=utf-8` media type.
   *
   * @param body - The HTML document text
   * @returns The handler result
   */
  html(body: string): HandlerResult {
    this.#body = body;
    this.#setBuiltInHeader('content-type', 'text/html; charset=utf-8', HTML_INIT);
    this.#ended = true;
    return HANDLER_RESULT;
  }

  send(body?: Uint8Array): HandlerResult {
    this.#body = body ?? null;
    if (body !== undefined && !this.#hasHeader('content-type')) {
      this.#setBuiltInHeader('content-type', 'application/octet-stream', BINARY_INIT);
    }
    this.#ended = true;
    return HANDLER_RESULT;
  }

  redirect(url: string, status: number = 302): HandlerResult {
    this.#status = status;
    this.#setBuiltInHeader('location', url, responseInit({ location: url }));
    this.#body = null;
    this.#ended = true;
    return HANDLER_RESULT;
  }

  /**
   * Sends a streaming response body.
   *
   * Accepts a web-standard {@linkcode ReadableStream} so that a handler can flush
   * bytes progressively over a long-lived connection instead of buffering a
   * whole body before send.
   *
   * @param body - A `ReadableStream` of `Uint8Array` chunks
   * @returns The handler result
   */
  stream(body: ReadableStream<Uint8Array>): HandlerResult {
    this.#body = body;
    this.#streaming = true;
    this.#ended = true;
    return HANDLER_RESULT;
  }

  /**
   * Returns a snapshot of the current response state.
   *
   * @returns The discriminated snapshot (status, headers, and either a buffered
   *   body or a live stream, keyed on `streaming`)
   */
  snapshot(): ResponseSnapshot {
    if (this.#streaming) {
      return new StreamingResponseSnapshot(
        this,
        this.#status,
        this.#body as ReadableStream<Uint8Array>,
      );
    }
    return new BufferedResponseSnapshot(
      this,
      this.#status,
      this.#body as Uint8Array | string | null,
    );
  }

  /** Whether a terminal method has been called (used to detect short-circuits). */
  get ended(): boolean {
    return this.#ended;
  }

  /** Returns the native Headers object, creating it only for mutable access. */
  #materializeHeaders(): Headers {
    if (this.#headers === undefined) {
      this.#headers = new Headers(this.#responseInit?.headers);
      this.#responseInit = undefined;
      this.#initHeaderName = undefined;
    }
    return this.#headers;
  }

  /** Supplies the documented live headers view to an internal snapshot. */
  headersForSnapshot(): Headers {
    return this.#materializeHeaders();
  }

  /** Supplies the current fast-path init to an internal snapshot. */
  responseInitForSnapshot(): ResponseSnapshotInit | undefined {
    const init = this.#responseInit;
    if (init === undefined) return undefined;

    // Native HTTP servers are allowed to add derived headers (for example,
    // Content-Length) to their response initializer. Keep the shared internal
    // source immutable, but give each snapshot consumer a mutable copy.
    return { headers: { ...init.headers } };
  }

  /** Writes one built-in header without materializing native Headers where possible. */
  #setBuiltInHeader(name: string, value: string, init: TerminalResponseInit): void {
    if (this.#headers !== undefined) {
      this.#headers.set(name, value);
      return;
    }
    if (this.#responseInit === undefined || this.#initHeaderName === name) {
      this.#responseInit = init;
      this.#initHeaderName = name;
      return;
    }
    this.#materializeHeaders().set(name, value);
  }

  /** Returns whether the current response already holds a named header. */
  #hasHeader(name: string): boolean {
    return this.#headers?.has(name) ?? this.#initHeaderName === name;
  }
}

/** Snapshot object for buffered responses, with prototype-backed accessors. */
class BufferedResponseSnapshot implements Extract<ResponseSnapshot, { readonly streaming: false }> {
  readonly streaming = false;
  readonly #response: ResponseBuilder;
  readonly status: number;
  readonly body: Uint8Array | string | null;

  constructor(
    response: ResponseBuilder,
    status: number,
    body: Uint8Array | string | null,
  ) {
    this.#response = response;
    this.status = status;
    this.body = body;
  }

  get responseInit(): ResponseSnapshotInit | undefined {
    return this.#response.responseInitForSnapshot();
  }

  get headers(): Headers {
    return this.#response.headersForSnapshot();
  }
}

/** Snapshot object for streaming responses, with prototype-backed accessors. */
class StreamingResponseSnapshot implements Extract<ResponseSnapshot, { readonly streaming: true }> {
  readonly streaming = true;
  readonly #response: ResponseBuilder;
  readonly status: number;
  readonly body: ReadableStream<Uint8Array>;

  constructor(
    response: ResponseBuilder,
    status: number,
    body: ReadableStream<Uint8Array>,
  ) {
    this.#response = response;
    this.status = status;
    this.body = body;
  }

  get responseInit(): ResponseSnapshotInit | undefined {
    return this.#response.responseInitForSnapshot();
  }

  get headers(): Headers {
    return this.#response.headersForSnapshot();
  }
}

/** Internal shared source for a terminal response's fast-path header init. */
interface TerminalResponseInit {
  readonly headers: Readonly<Record<string, string>>;
}

/** Freezes a terminal response's internal header source before it is copied to a snapshot. */
function responseInit(headers: Record<string, string>): TerminalResponseInit {
  return Object.freeze({ headers: Object.freeze(headers) });
}
