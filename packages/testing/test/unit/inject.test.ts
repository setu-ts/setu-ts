import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { collectStream, inject } from '../../src/inject.ts';
import type { StreamingBody } from '../../src/inject.ts';
import type { IKernelApplication, InjectRequest, InjectResponse } from '@hono-enterprise/kernel';

// Fake app that records the inject call
interface RecordedInject {
  request: InjectRequest;
}

function createFakeApp(): {
  app: IKernelApplication;
  recorded: RecordedInject[];
} {
  const recorded: RecordedInject[] = [];
  const fakeResponse: InjectResponse = {
    get statusCode() {
      return 200;
    },
    get headers() {
      return new Headers();
    },
    get body() {
      return 'ok';
    },
    json<T>(): T {
      return { ok: true } as T;
    },
  };
  const app: IKernelApplication = {
    inject: (request: InjectRequest): InjectResponse => {
      recorded.push({ request });
      return fakeResponse;
    },
    fetch: () => Promise.resolve(new Response('ok')),
    stop: () => Promise.resolve(),
  } as unknown as IKernelApplication;

  return { app, recorded };
}

describe('inject (free function)', () => {
  it('string URL shorthand becomes GET request', async () => {
    const { app, recorded } = createFakeApp();
    await inject(app, '/users');

    expect(recorded).toHaveLength(1);
    expect(recorded[0].request).toEqual({ method: 'GET', url: '/users' });
  });

  it('InjectRequest passes through unchanged', async () => {
    const { app, recorded } = createFakeApp();
    await inject(app, { method: 'POST', url: '/users', body: { name: 'test' } });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].request).toEqual({
      method: 'POST',
      url: '/users',
      body: { name: 'test' },
    });
  });

  it('web Request normalizes method, url, and headers', async () => {
    const { app, recorded } = createFakeApp();
    const req = new Request('http://localhost/api/users', {
      method: 'PUT',
      headers: { 'X-Custom': 'value' },
    });
    await inject(app, req);

    expect(recorded).toHaveLength(1);
    expect(recorded[0].request.method).toBe('PUT');
    expect(recorded[0].request.url).toBe('http://localhost/api/users');
  });

  it('web Request with body reads text for non-GET/HEAD methods', async () => {
    const { app, recorded } = createFakeApp();
    const bodyContent = 'hello world';
    const req = new Request('http://localhost/data', {
      method: 'POST',
      body: bodyContent,
    });
    await inject(app, req);

    expect(recorded).toHaveLength(1);
    expect(recorded[0].request.body).toBe(bodyContent);
  });

  // --- P1-3 empty string body preservation ---
  it('web Request with empty body preserves body field for POST (P1-3)', async () => {
    const { app, recorded } = createFakeApp();
    const req = new Request('http://localhost/data', {
      method: 'POST',
      body: '',
    });
    await inject(app, req);

    expect(recorded).toHaveLength(1);
    // The body key MUST be present (even though empty) because the
    // original Request.body is non-null — real kernel path would parse it.
    expect(recorded[0].request).toHaveProperty('body', '');
  });

  it('POST with no body at all omits the body key', async () => {
    const { app, recorded } = createFakeApp();
    await inject(app, new Request('http://localhost/data', { method: 'POST' }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].request).not.toHaveProperty('body');
  });

  // A Request body is a one-shot stream. Reusing one used to be swallowed by an
  // empty catch, which injected NO body and left the handler seeing an empty
  // payload with nothing explaining why. Fail fast and name the cause instead.
  it('re-injecting a consumed Request throws instead of silently dropping the body', async () => {
    const { app, recorded } = createFakeApp();
    const req = new Request('http://localhost/data', { method: 'POST', body: 'once' });

    // First inject succeeds and reads the body.
    await inject(app, req);
    expect(recorded[0].request.body).toBe('once');

    // The same Request a second time — its body is now consumed.
    let message = '';
    try {
      await inject(app, req);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('its body has already been consumed');
    expect(message).toContain('build a separate Request for each call');
    // Crucially: it threw rather than delivering a second bodyless request.
    expect(recorded).toHaveLength(1);
  });

  it('a Request already read by the caller throws on inject', async () => {
    const { app, recorded } = createFakeApp();
    const req = new Request('http://localhost/data', { method: 'POST', body: 'x' });
    await req.text(); // caller consumed it themselves
    expect(req.bodyUsed).toBe(true);

    let message = '';
    try {
      await inject(app, req);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('its body has already been consumed');
    expect(recorded).toHaveLength(0);
  });

  it('a consumed GET Request still injects — GET carries no body to re-read', async () => {
    const { app, recorded } = createFakeApp();
    const req = new Request('http://localhost/users');
    await inject(app, req);
    await inject(app, req);

    expect(recorded).toHaveLength(2);
    expect(recorded[1].request.method).toBe('GET');
  });
});

describe('collectStream', () => {
  it('reads a synthetic ReadableStream into expected chunks and text', async () => {
    const encoder = new TextEncoder();
    const chunk1 = encoder.encode('hello');
    const chunk2 = encoder.encode(' world');

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.close();
      },
    });

    const response = new Response(stream);
    const result = await collectStream(response);

    // Verify StreamingBody type is satisfied
    const _sb: StreamingBody = result;
    expect(_sb.chunks).toHaveLength(2);
    expect(_sb.chunks[0]).toEqual(chunk1);
    expect(_sb.chunks[1]).toEqual(chunk2);
    expect(_sb.text).toBe('hello world');
  });

  it('throws when response body is null', async () => {
    const response = new Response(null);
    await expect(collectStream(response)).rejects.toThrow(
      'collectStream: response body is null',
    );
  });
});
