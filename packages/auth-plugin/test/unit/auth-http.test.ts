import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { AuthHttpBodyTooLargeError, createDefaultAuthHttp } from '../../src/issuers/auth-http.ts';

function streamOf(chunks: Uint8Array[], endless = false) {
  let cancelled = false;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else if (endless) {
        controller.enqueue(new Uint8Array(1024));
      } else {
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, wasCancelled: () => cancelled };
}

describe('createDefaultAuthHttp', () => {
  it('returns status and text, refusing redirects and passing the signal', async () => {
    const seen: RequestInit[] = [];
    const http = createDefaultAuthHttp((_url, init) => {
      seen.push(init);
      const { stream } = streamOf([
        new TextEncoder().encode('{"a":'),
        new TextEncoder().encode('1}'),
      ]);
      return Promise.resolve(new Response(stream, { status: 200 }));
    });
    const signal = new AbortController().signal;
    const response = await http.get('https://idp.test/jwks', { signal, maxBytes: 100 });
    expect(response).toEqual({ status: 200, body: '{"a":1}' });
    // 'manual', never 'error': Cloudflare Workers throws on 'error'.
    expect(seen[0].redirect).toBe('manual');
    expect(seen[0].signal).toBe(signal);
  });

  it('returns an empty body for a bodiless response', async () => {
    const http = createDefaultAuthHttp(() => Promise.resolve(new Response(null, { status: 404 })));
    const response = await http.get('https://x.test', {
      signal: new AbortController().signal,
      maxBytes: 10,
    });
    expect(response).toEqual({ status: 404, body: '' });
  });

  it('cancels a never-ending body once it passes maxBytes', async () => {
    const endless = streamOf([], true);
    const http = createDefaultAuthHttp(() => Promise.resolve(new Response(endless.stream)));
    await expect(
      http.get('https://x.test', { signal: new AbortController().signal, maxBytes: 4096 }),
    ).rejects.toBeInstanceOf(AuthHttpBodyTooLargeError);
    expect(endless.wasCancelled()).toBe(true);
  });

  it('aborts through the signal', async () => {
    const controller = new AbortController();
    const http = createDefaultAuthHttp((_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })
    );
    const pending = http.get('https://x.test', { signal: controller.signal, maxBytes: 10 });
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });

  it('POSTs the form url-encoded, asking for JSON, and reports status and body', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const http = createDefaultAuthHttp((url, init) => {
      seen.push({ url, init });
      return Promise.resolve(new Response('{"access_token":"a1"}', { status: 200 }));
    });
    const signal = new AbortController().signal;
    const response = await http.post('https://idp.test/token', {
      signal,
      maxBytes: 2048,
      form: { grant_type: 'authorization_code', code: 'c/1+2' },
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(response).toEqual({ status: 200, body: '{"access_token":"a1"}' });
    expect(seen[0].url).toBe('https://idp.test/token');
    expect(seen[0].init.method).toBe('POST');
    expect(seen[0].init.signal).toBe(signal);
    // 'manual' for POST too: a token endpoint that redirects must not be followed
    // with the client's credentials in tow.
    expect(seen[0].init.redirect).toBe('manual');
    const headers = new Headers(seen[0].init.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(headers.get('authorization')).toBe('Basic dXNlcjpwYXNz');
    // The seam encodes, so a value containing a separator stays ONE parameter.
    expect(seen[0].init.body).toBe('grant_type=authorization_code&code=c%2F1%2B2');
  });

  it('sends caller headers on a GET beside the JSON accept header (M100c F2)', async () => {
    const seen: Headers[] = [];
    const http = createDefaultAuthHttp((_url, init) => {
      seen.push(new Headers(init.headers));
      return Promise.resolve(new Response('{}'));
    });
    await http.get('https://idp.test/userinfo', {
      signal: new AbortController().signal,
      maxBytes: 512,
      headers: { authorization: 'Bearer t' },
    });
    expect(seen[0].get('authorization')).toBe('Bearer t');
    expect(seen[0].get('accept')).toBe('application/json');
  });

  it('a secret containing & cannot inject a second form parameter', async () => {
    let body = '';
    const http = createDefaultAuthHttp((_url, init) => {
      body = String(init.body);
      return Promise.resolve(new Response('{}'));
    });
    await http.post('https://idp.test/token', {
      signal: new AbortController().signal,
      maxBytes: 512,
      // Decoded naively this would read as client_secret=x, admin=true.
      form: { client_secret: 'x admin=true' },
    });
    expect(body).toBe('client_secret=x+admin%3Dtrue');
    const params = new URLSearchParams(body);
    expect([...params.keys()]).toEqual(['client_secret']);
    expect(params.get('client_secret')).toBe('x admin=true');
  });

  it('cancels an oversized POST body once it passes maxBytes', async () => {
    const endless = streamOf([], true);
    const http = createDefaultAuthHttp(() => Promise.resolve(new Response(endless.stream)));
    await expect(
      http.post('https://idp.test/token', {
        signal: new AbortController().signal,
        maxBytes: 1024,
        form: {},
      }),
    ).rejects.toBeInstanceOf(AuthHttpBodyTooLargeError);
    expect(endless.wasCancelled()).toBe(true);
  });

  it('defaults to the global fetch, called with the global as receiver', async () => {
    const original = globalThis.fetch;
    let receiver: unknown = null;
    globalThis.fetch = function (this: unknown) {
      receiver = this;
      return Promise.resolve(new Response('{}'));
    } as typeof fetch;
    try {
      const http = createDefaultAuthHttp();
      await http.get('https://x.test', { signal: new AbortController().signal, maxBytes: 10 });
      expect(receiver).toBe(globalThis);
    } finally {
      globalThis.fetch = original;
    }
  });
});
