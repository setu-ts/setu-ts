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
    expect(seen[0].redirect).toBe('error');
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
