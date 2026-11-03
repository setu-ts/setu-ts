import { describe, expect, it, vi } from 'vitest';
import type { IServiceRegistry } from '@setu-ts/common';
import { readClientDocument } from '../../src/client/document-source.ts';
import { createFakeApp } from '../fixtures/fake-app.ts';
import { createFakeFs } from '../fixtures/fake-fs.ts';

const DOCUMENT = { openapi: '3.1.0', paths: {} };
const JSON_TEXT = JSON.stringify(DOCUMENT);
const CAP = 16 * 1024 * 1024;

function harness() {
  const fs = createFakeFs({ '/cwd/doc.json': JSON_TEXT });
  const app = createFakeApp();
  const getSpec = vi.fn(() => DOCUMENT);
  const has = vi.fn(() => true);
  const services = { has, get: () => ({ getSpec }) } as unknown as IServiceRegistry;
  const start = vi.fn(app.start);
  const stop = vi.fn(app.stop);
  const loadApp = vi.fn(() =>
    Promise.resolve().then(() => ({
      createApp: () => Object.assign(Object.create(app) as typeof app, { start, stop, services }),
    })),
  );
  const errors: string[] = [];
  const deps = { fs, cwd: '/cwd', loadApp, log: () => {}, error: (s: string) => errors.push(s) };
  return {
    ...deps,
    getSpec,
    has,
    start,
    stop,
    errors,
    read: (input?: string) => readClientDocument(deps, '/project', undefined, input),
  };
}

describe('client document boot', () => {
  it('reads the OpenAPI capability only after starting, without listening', async () => {
    const h = harness();
    h.getSpec.mockImplementation(() => {
      expect(h.start).toHaveBeenCalledWith();
      expect(h.stop).not.toHaveBeenCalled();
      return DOCUMENT;
    });
    expect(await h.read()).toBe(DOCUMENT);
    expect(h.has).toHaveBeenCalledWith('openapi');
    expect(h.stop).toHaveBeenCalledOnce();
  });
  it('refuses missing openapi and still stops', async () => {
    const h = harness();
    h.has.mockReturnValue(false);
    await expect(h.read()).rejects.toThrow('openapi-plugin is not registered');
    expect(h.getSpec).not.toHaveBeenCalled();
    expect(h.stop).toHaveBeenCalledOnce();
  });
  for (const point of ['start', 'getSpec'] as const)
    it(`tears down when ${point} throws`, async () => {
      const h = harness();
      h[point].mockImplementation(() => {
        throw new Error(`${point} failed`);
      });
      await expect(h.read()).rejects.toThrow(`${point} failed`);
      expect(h.stop).toHaveBeenCalledOnce();
    });
  it('warns about failing stop without changing the result, even for non-Error throws', async () => {
    for (const failure of [new Error('stop failed'), 'stop failed']) {
      const h = harness();
      h.stop.mockRejectedValue(failure);
      expect(await h.read()).toBe(DOCUMENT);
      expect(h.errors.join('\n')).toContain(
        'Warning: the application did not shut down cleanly: stop failed',
      );
    }
  });
});

describe('client JSON input', () => {
  it('review 1 escapes the --input path in a non-regular-file error', async () => {
    const h = harness();
    const input = 'doc-\u001b[31m\nINJECTED.json';
    await h.fs.mkdir(`/cwd/${input}`);
    await expect(h.read(input)).rejects.toThrow(
      '/cwd/doc-\\u001b[31m\\u000aINJECTED.json is not a regular file.',
    );
  });

  it('resolves files relative to CWD rather than dir, without loading the app', async () => {
    const h = harness();
    expect(await h.read('doc.json')).toEqual(DOCUMENT);
    expect(h.loadApp).not.toHaveBeenCalled();
  });
  for (const [text, reason] of [
    ['openapi: 3.1.0', 'JSON; YAML'],
    ['null', 'must be an object'],
    ['[]', 'must be an object'],
    ['{}', 'document.openapi'],
    ['{"openapi":3}', 'document.openapi'],
    ['{"openapi":"2.0"}', 'document.openapi'],
    ['{"openapi":"3.0.0"}', 'document.paths'],
    ['{"openapi":"3.0.0","paths":[]}', 'document.paths'],
    ['{"openapi":"3.0.0","paths":null}', 'document.paths'],
  ])
    it(`refuses ${text}`, async () => {
      const h = harness();
      await h.fs.writeFile('/cwd/doc.json', new TextEncoder().encode(text));
      await expect(h.read('doc.json')).rejects.toThrow(reason);
    });
  it('reports missing files and refuses non-regular files', async () => {
    const h = harness();
    await expect(h.read('absent.json')).rejects.toThrow('No such file');
    await expect(h.read('/cwd')).rejects.toThrow('not a regular file');
  });
  it('refuses oversized files before opening and after a growing fallback read', async () => {
    const h = harness();
    h.fs.stat = () =>
      Promise.resolve().then(() => ({ isFile: true, isDirectory: false, size: CAP + 1 }));
    h.fs.readFile = vi.fn(() => Promise.resolve().then(() => new Uint8Array()));
    await expect(h.read('doc.json')).rejects.toThrow('larger than 16 MiB');
    expect(h.fs.readFile).not.toHaveBeenCalled();
    h.fs.stat = () => Promise.resolve().then(() => ({ isFile: true, isDirectory: false, size: 1 }));
    h.fs.readFile = () => Promise.resolve().then(() => new Uint8Array(CAP + 1));
    await expect(h.read('doc.json')).rejects.toThrow('larger than 16 MiB');
  });
  it('uses bounded handle reads when supplied', async () => {
    const h = harness();
    const readRegularFile = vi.fn(() =>
      Promise.resolve().then(() => new TextEncoder().encode(JSON_TEXT)),
    );
    expect(
      await readClientDocument(
        { ...h, fs: { ...h.fs, readRegularFile } },
        '/project',
        undefined,
        'doc.json',
      ),
    ).toEqual(DOCUMENT);
    expect(readRegularFile).toHaveBeenCalledWith('/cwd/doc.json', CAP);
  });
  it('counts file stream chunks and cancels an over-limit stream', async () => {
    const h = harness();
    const cancel = vi.fn();
    h.fs.readStream = () =>
      Promise.resolve().then(
        () =>
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(CAP));
              c.enqueue(new Uint8Array(1));
            },
            cancel,
          }),
      );
    await expect(h.read('doc.json')).rejects.toThrow('larger than 16 MiB');
    expect(cancel).toHaveBeenCalledOnce();
    h.fs.readStream = () => Promise.resolve().then(() => new Response(JSON_TEXT).body!);
    expect(await h.read('doc.json')).toEqual(DOCUMENT);
  });

  it('fetches JSON with the 30s timeout and accept header without booting', async () => {
    const h = harness();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetcher = vi.fn(() => Promise.resolve().then(() => new Response(JSON_TEXT)));
    expect(
      await readClientDocument(
        { ...h, fetch: fetcher },
        '/project',
        undefined,
        'https://example.test/openapi.json',
      ),
    ).toEqual(DOCUMENT);
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(fetcher).toHaveBeenCalledWith('https://example.test/openapi.json', {
      headers: { accept: 'application/json' },
      signal: expect.any(AbortSignal),
    });
    expect(h.loadApp).not.toHaveBeenCalled();
    timeout.mockRestore();
  });
  it('propagates a timeout abort without hanging', async () => {
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(AbortSignal.abort(new DOMException('deadline', 'TimeoutError')));
    try {
      const h = harness();
      const fetcher: typeof fetch = (_input, init) =>
        Promise.resolve().then(() => {
          init?.signal?.throwIfAborted();
          throw new Error('expected abort');
        });
      await expect(
        readClientDocument({ ...h, fetch: fetcher }, '/project', undefined, 'http://example.test'),
      ).rejects.toThrow('deadline');
    } finally {
      timeout.mockRestore();
    }
  });
  it('names HTTP failure status and cancels its body', async () => {
    const h = harness();
    const response = new Response('forbidden', { status: 403 });
    const cancel = vi.spyOn(response.body!, 'cancel');
    await expect(
      readClientDocument(
        { ...h, fetch: () => Promise.resolve().then(() => response) },
        '/project',
        undefined,
        'https://example.test',
      ),
    ).rejects.toThrow('HTTP 403');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('handles empty bodies and bodyless HTTP failures', async () => {
    const h = harness();
    for (const [status, reason] of [
      [204, 'valid JSON'],
      [404, 'HTTP 404'],
    ] as const)
      await expect(
        readClientDocument(
          { ...h, fetch: () => Promise.resolve().then(() => new Response(null, { status })) },
          '/project',
          undefined,
          'https://example.test',
        ),
      ).rejects.toThrow(reason);
  });
  it('counts HTTP chunks independently of content-length and cancels at the cap', async () => {
    const h = harness();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(CAP));
        c.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    await expect(
      readClientDocument(
        {
          ...h,
          fetch: () =>
            Promise.resolve().then(
              () => new Response(stream, { headers: { 'content-length': '1' } }),
            ),
        },
        '/project',
        undefined,
        'https://example.test',
      ),
    ).rejects.toThrow('larger than 16 MiB');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('uses the default web fetch when none is injected', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON_TEXT));
    try {
      expect(await harness().read('http://example.test')).toEqual(DOCUMENT);
    } finally {
      fetcher.mockRestore();
    }
  });
});
