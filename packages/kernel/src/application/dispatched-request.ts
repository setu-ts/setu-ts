/** Web Request adaptation for in-process dispatch. @module */
import { installRequestIdentityGuard, parseFormBody, parseJsonBody } from '@setu-ts/common';
import type {
  DispatchOptions,
  FormBody,
  HttpMethod,
  IPrincipal,
  IRequest,
  ITenant,
} from '@setu-ts/common';

/** Lazy body reader using the same identity guard as adapter-served requests. */
export class DispatchedRequest implements IRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Headers;
  readonly signal: AbortSignal;
  readonly raw: Request;
  /** Internal route pin, checked after matching and before the route's middleware. */
  readonly expectedRoute: string | undefined;
  declare readonly ip?: string;
  declare user?: IPrincipal;
  declare tenant?: ITenant;
  declare locale?: string;
  #bytes: Promise<Uint8Array> | undefined;
  #form: Promise<FormBody> | undefined;

  /** @param request - Native request to adapt
   * @param options - Reported peer and expected route supplied by the caller
   */
  constructor(request: Request, options?: DispatchOptions) {
    installRequestIdentityGuard(DispatchedRequest.prototype);
    this.raw = request;
    this.expectedRoute = options?.route;
    this.method = request.method as HttpMethod;
    this.url = request.url;
    this.headers = new Headers(request.headers);
    this.signal = request.signal;
    if (options?.ip !== undefined) (this as { ip?: string }).ip = options.ip;
  }

  get path(): string {
    return new URL(this.url).pathname;
  }
  async bytes(): Promise<Uint8Array> {
    this.#bytes ??= this.raw.arrayBuffer().then((buffer) => new Uint8Array(buffer));
    return await this.#bytes;
  }
  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes());
  }
  async json<T>(): Promise<T> {
    return parseJsonBody(await this.text()) as T;
  }
  formData(): Promise<FormBody> {
    this.#form ??= this.bytes().then((bytes) =>
      parseFormBody(bytes, this.headers.get('content-type')),
    );
    return this.#form;
  }
}
