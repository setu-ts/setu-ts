/**
 * M99c V7-1 end to end: ONE multipart `Blob` driven through BOTH of the
 * framework's request entry points must parse identically.
 *
 * `app.fetch` receives a web-standard `Request` — and the PLATFORM sets its
 * `content-type` from `blob.type`, the fact this disagreement turns on.
 * `app.inject` used to drop that fact: the `Blob` arm contributed no
 * content-type default, so the form parse refused the very body it was handed
 * and the route answered 500 (`UnsupportedFormEncodingError`, naming the
 * wrong cause) where the same Blob through `fetch()` answered 200. The inject
 * leg now defaults the header from a non-empty `blob.type`, matching the
 * platform — which is exactly what this file pins, both legs against one
 * handler.
 *
 * The fetch leg runs through a local adapter reproducing the runtime
 * adapters' composition — web `Request` → `IRequest` → kernel handler →
 * snapshot → `Response` — over the SAME shared body parses
 * (`parseFormBody`/`parseJsonBody`) the served path uses. `@setu-ts/runtime`
 * cannot be imported from a kernel test: kernel sits BELOW runtime in the
 * dependency direction (common ← kernel ← runtime), and no package imports
 * another package's internals.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, parseFormBody, parseJsonBody } from '@setu-ts/common';
import type {
  FormBody,
  IHttpAdapter,
  IPlugin,
  IPluginContext,
  IRequest,
  IResponse,
  ResponseSnapshot,
  ServerHandle,
} from '@setu-ts/common';

import { createApplication } from '../../src/application/application.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

const BOUNDARY = '----m99c-inject-blob';
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

/** Builds the multipart body as a typed Blob, exactly as an upload would. */
function multipartBlob(): Blob {
  const encoder = new TextEncoder();
  const segments = [
    `--${BOUNDARY}\r\n`,
    'Content-Disposition: form-data; name="note"\r\n\r\n',
    'hello\r\n',
    `--${BOUNDARY}--\r\n`,
  ];
  return new Blob([encoder.encode(segments.join(''))], { type: CONTENT_TYPE });
}

/**
 * Maps a web `Request` the way the runtime adapters map it (shared-parse
 * composition, memoized form read). Only the transport is absent — this test
 * never binds a socket.
 */
async function toFrameworkRequest(raw: Request): Promise<IRequest> {
  const bytes = new Uint8Array(await raw.arrayBuffer());
  const contentType = raw.headers.get('content-type');
  let form: Promise<FormBody> | undefined;
  return {
    method: raw.method as IRequest['method'],
    url: raw.url,
    path: new URL(raw.url).pathname,
    headers: new Headers(raw.headers),
    raw,
    json<T>(): Promise<T> {
      return Promise.resolve().then(() => parseJsonBody(new TextDecoder().decode(bytes)) as T);
    },
    text(): Promise<string> {
      return Promise.resolve(new TextDecoder().decode(bytes));
    },
    bytes(): Promise<Uint8Array> {
      return Promise.resolve(bytes);
    },
    formData(): Promise<FormBody> {
      form ??= Promise.resolve().then(() => parseFormBody(bytes, contentType));
      return form;
    },
  };
}

function toWebResponse(snapshot: ResponseSnapshot): Response {
  const init: ResponseInit = { status: snapshot.status, headers: snapshot.headers };
  if (snapshot.streaming) return new Response(snapshot.body, init);
  const body = snapshot.body;
  if (body instanceof Uint8Array) {
    // A fresh ArrayBuffer-backed copy satisfies `BodyInit` on every runtime
    // lib — a bare `Uint8Array<ArrayBufferLike>` does not type as one.
    return new Response(body.slice().buffer as ArrayBuffer, init);
  }
  return new Response(body, init);
}

/**
 * The fetch-capable half of the runtime adapter contract: `setHandler` +
 * `fetch`. `listen`/`close` exist to complete `IHttpAdapter`; this test never
 * calls them.
 */
class FetchThroughAdapter implements IHttpAdapter {
  #handler: ((request: IRequest) => IResponse | Promise<IResponse>) | undefined;

  setHandler(handler: (request: IRequest) => IResponse | Promise<IResponse>): void {
    this.#handler = handler;
  }

  async fetch(request: Request): Promise<Response> {
    if (this.#handler === undefined) {
      return new Response('Handler not set', { status: 500 });
    }
    const response = await this.#handler(await toFrameworkRequest(request));
    return toWebResponse(response.snapshot());
  }

  listen(): Promise<ServerHandle> {
    return Promise.reject(new Error('this test never binds a socket'));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

interface ParsedUpload {
  readonly note: string | null;
  readonly servedContentType: string | null;
}

async function buildApp(): Promise<ReturnType<typeof createApplication>> {
  const runtime: IPlugin = {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, createFakeRuntime().runtime);
      ctx.services.register(CAPABILITIES.HTTP_ADAPTER, new FetchThroughAdapter());
    },
  };

  const app = createApplication({ plugins: [runtime] });

  app.router.post('/upload', async (ctx) => {
    if (ctx.request.formData === undefined) {
      throw new Error('the request must carry the formData accessor');
    }
    const form = await ctx.request.formData();
    return ctx.response.json({
      note: form.get('note'),
      servedContentType: ctx.request.headers.get('content-type'),
    });
  });

  // Plugins register during start(); setHandler runs there too, which is what
  // makes `app.fetch` work without a bound socket. No port → no listener.
  await app.start();

  return app;
}

describe('ONE multipart Blob through both request entry points (M99c V7-1)', () => {
  it('parses identically through app.fetch and app.inject', async () => {
    const app = await buildApp();

    // The platform fact the disagreement turns on: a Blob DECLARES its type,
    // and `new Request(url, { body: blob })` sets the header from it.
    const blob = multipartBlob();
    const platformRequest = new Request('http://localhost/upload', {
      method: 'POST',
      body: blob,
    });
    expect(platformRequest.headers.get('content-type')).toBe(CONTENT_TYPE);

    const fetched = await app.fetch(platformRequest);
    expect(fetched.status).toBe(200);
    const served = await fetched.json() as ParsedUpload;

    // A SECOND Blob, same shape: the entry points must agree on what one
    // upload means, not share mutable state.
    const injected = await app.inject({
      method: 'POST',
      url: '/upload',
      body: multipartBlob(),
    });
    expect(injected.statusCode).toBe(200);
    const injectedParsed = injected.json<ParsedUpload>();

    // Before the fix this leg answered 500 with an error claiming the body
    // was NOT multipart — while the same bytes through fetch parsed fine.
    expect(injectedParsed).toEqual(served);
    expect(injectedParsed.note).toBe('hello');
    expect(injectedParsed.servedContentType).toBe(CONTENT_TYPE);

    await app.stop();
  });
});
