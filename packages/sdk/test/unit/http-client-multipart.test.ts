import { describe, expect, it } from 'vitest';
import { createClient } from '../../src/index.ts';

describe('HTTP client multipart bodies', () => {
  it('passes FormData and removes default and caller Content-Type headers', async () => {
    const client = createClient({
      baseUrl: 'https://example.test',
      headers: { 'Content-Type': 'application/json', 'x-default': 'ok' },
      fetch: async (_input, init) => {
        expect(init?.body).toBeInstanceOf(FormData);
        expect(new Headers(init?.headers).has('content-type')).toBe(false);
        expect(new Headers(init?.headers).get('x-default')).toBe('ok');
        const request = new Request('https://example.test/uploads', init);
        expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
        const form = await request.formData();
        expect(form.get('title')).toBe('hello');
        const file = form.get('file') as File;
        expect(file.name).toBe('hello.txt');
        expect(await file.text()).toBe('hello');
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      },
    });
    await client.request({
      method: 'POST',
      path: 'uploads',
      multipart: { title: 'hello', file: new File(['hello'], 'hello.txt') },
      headers: { 'cOnTeNt-TyPe': 'text/plain' },
    });
  });
  it('reuses the same FormData with identical entries for a retried keyed POST', async () => {
    const bodies: unknown[] = [];
    const entries: string[] = [];
    const client = createClient({
      baseUrl: 'https://example.test',
      timing: { now: () => 0, sleep: () => Promise.resolve() },
      retry: { limit: 2, delay: 0, backoff: 'fixed' },
      fetch: async (_input, init) => {
        bodies.push(init?.body);
        const form = await new Request('https://example.test/uploads', init).formData();
        entries.push(`${form.get('title')}:${await (form.get('file') as File).text()}`);
        return bodies.length === 1
          ? new Response('retry', { status: 503 })
          : new Response('{}', { headers: { 'content-type': 'application/json' } });
      },
    });
    await client.request({
      method: 'POST',
      path: 'uploads',
      idempotencyKey: 'retry-upload',
      multipart: { title: 'hello', file: new Blob(['bytes']) },
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(entries).toEqual(['hello:bytes', 'hello:bytes']);
  });
  it('refuses json plus multipart before interceptors or fetch', async () => {
    let calls = 0;
    const client = createClient({
      baseUrl: 'https://example.test',
      requestInterceptors: [
        () => {
          calls++;
        },
      ],
      fetch: () => {
        calls++;
        return Promise.resolve(new Response());
      },
    });
    await expect(
      client.request({ method: 'POST', path: 'uploads', json: null, multipart: {} }),
    ).rejects.toThrow('json and multipart are mutually exclusive');
    expect(calls).toBe(0);
  });
});
