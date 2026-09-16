/**
 * Pins the exact string the `cacheControl` callback receives, per R13's five
 * measured cases — through the REAL handler, not `resolveCacheControl` alone —
 * so the documented value and the delivered value are pinned together.
 *
 * C3/§3.6 kept the BEHAVIOUR (the full request path including `urlPrefix`) and
 * corrected the docs; negative control 5 makes the chosen side fail loudly: if
 * `callbackPath` ever strips the prefix again, the prefixed rows below fail.
 * The `never '/'` pin at the bottom is the corrected README sentence checked
 * rather than reviewed — a directory request delivers its resolved index path,
 * in every configuration, root mount included (R14).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createStaticHandler } from '../../src/handler/static-handler.ts';
import type { RouteHandler } from '@setu-ts/common';

const encoder = new TextEncoder();

interface Harness {
  readonly handler: RouteHandler;
  readonly received: string[];
}

function harness(urlPrefix: string): Harness {
  const received: string[] = [];

  const files = new Map<string, Uint8Array>([
    ['/root/app-A9acsx54.js', encoder.encode('JS')],
    ['/root/index.html', encoder.encode('<html></html>')],
  ]);
  const fs = {
    realPath: (path: string) => Promise.resolve(path),
    readFile: (path: string) => {
      const data = files.get(path);
      if (!data) return Promise.reject(new Error('ENOENT'));
      return Promise.resolve(data);
    },
    stat: (path: string) => {
      if (files.has(path)) {
        return Promise.resolve({
          isFile: true,
          isDirectory: false,
          size: files.get(path)?.length ?? 0,
        });
      }
      if (path === '/root' || path === '/root/assets') {
        return Promise.resolve({ isFile: false, isDirectory: true, size: 0 });
      }
      // A missing sidecar (.br/.gz) and a missing anything else: ENOENT.
      return Promise.reject(new Error('ENOENT'));
    },
    writeFile: () => Promise.resolve(),
    mkdir: () => Promise.resolve(),
    readdir: () => Promise.resolve([]),
    rm: () => Promise.resolve(),
  };

  const handler = createStaticHandler({
    // deno-lint-ignore no-explicit-any
    fs: fs as any,
    root: '/root',
    urlPrefix,
    index: 'index.html',
    cacheControl: (requestPath) => {
      received.push(requestPath);
      return 'public, max-age=60';
    },
  }) as RouteHandler;

  return { handler, received };
}

async function serve(h: Harness, requestPath: string): Promise<void> {
  const ctx = {
    id: 'test-id',
    request: {
      path: requestPath,
      method: 'GET',
      headers: new Headers(),
      url: `http://localhost${requestPath}`,
    },
    response: {
      status() {
        return this;
      },
      header() {
        return this;
      },
      send() {
        return { kind: 'sent' };
      },
      stream() {
        return { kind: 'streamed' };
      },
    },
  };
  await h.handler(ctx as never);
}

describe('the cacheControl callback receives the full request path (R13)', () => {
  it('prefixed mount: file, bare-prefix directory, and slash-suffixed directory', async () => {
    const h = harness('/assets');

    await serve(h, '/assets/app-A9acsx54.js');
    expect(h.received.at(-1)).toBe('/assets/app-A9acsx54.js');

    await serve(h, '/assets');
    expect(h.received.at(-1)).toBe('/assets/index.html');

    await serve(h, '/assets/');
    expect(h.received.at(-1)).toBe('/assets/index.html');
  });

  it('root mount: the prefix is empty, so the request path is the whole story', async () => {
    const h = harness('/');

    await serve(h, '/app-A9acsx54.js');
    expect(h.received.at(-1)).toBe('/app-A9acsx54.js');

    await serve(h, '/');
    expect(h.received.at(-1)).toBe('/index.html');
  });

  it('never receives the literal "/" — a directory delivers its index (R14)', async () => {
    for (const urlPrefix of ['/assets', '/']) {
      const h = harness(urlPrefix);
      await serve(h, urlPrefix);
      await serve(h, urlPrefix === '/' ? '/' : `${urlPrefix}/`);
      await serve(h, `${urlPrefix === '/' ? '' : urlPrefix}/app-A9acsx54.js`);
      expect(h.received.length).toBe(3);
      expect(h.received).not.toContain('/');
    }
  });
});
