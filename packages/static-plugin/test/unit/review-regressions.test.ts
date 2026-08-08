/**
 * Regressions for the M55 code-review findings.
 *
 * Each test here fails without its corresponding fix. They are grouped in one
 * file because they share the fake-filesystem harness below and because they
 * document one review pass rather than one feature.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IFileSystem, StatResult } from '@setu-ts/common';
import { createStaticHandler } from '../../src/handler/static-handler.ts';
import { isEncodingAcceptable } from '../../src/http/precompressed.ts';
import { parseRange } from '../../src/http/range.ts';

/** Records what a captured response was given. */
type Captured = {
  status: number;
  headers: Headers;
  streamed: boolean;
  bodyLength: number | undefined;
};

/** Builds a request context whose response object records what it receives. */
function makeCtx(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): { ctx: Parameters<ReturnType<typeof createStaticHandler>>[0]; captured: Captured } {
  const captured: Captured = {
    status: 0,
    headers: new Headers(),
    streamed: false,
    bodyLength: undefined,
  };
  const response = {
    status(s: number) {
      captured.status = s;
      return response;
    },
    header(k: string, v: string) {
      captured.headers.set(k, v);
      return response;
    },
    send(body?: Uint8Array) {
      captured.bodyLength = body?.length;
      return captured;
    },
    stream(_body: ReadableStream<Uint8Array>) {
      captured.streamed = true;
      return captured;
    },
  };
  const ctx = {
    request: { method, path, headers: new Headers(headers) },
    response,
  };
  return { ctx: ctx as unknown as Parameters<ReturnType<typeof createStaticHandler>>[0], captured };
}

/** A file entry for {@linkcode makeFs}. */
type Entry = { size: number; isDirectory?: boolean };

/**
 * Builds a fake filesystem over a path→entry map, counting stream opens and
 * cancels so a leaked descriptor is observable.
 */
function makeFs(
  entries: Record<string, Entry>,
  counters: { opened: number; cancelled: number; stats: number },
  withReadStream = true,
): IFileSystem {
  const stat = (p: string): Promise<StatResult> => {
    counters.stats++;
    const entry = entries[p];
    if (!entry) return Promise.reject(new Error(`ENOENT: ${p}`));
    return Promise.resolve({
      isFile: !entry.isDirectory,
      isDirectory: entry.isDirectory === true,
      size: entry.size,
    });
  };

  const fs: IFileSystem = {
    readFile: (p: string) => Promise.resolve(new Uint8Array(entries[p]?.size ?? 0)),
    writeFile: () => Promise.resolve(),
    stat,
    readdir: () => Promise.resolve([]),
    mkdir: () => Promise.resolve(),
    rm: () => Promise.resolve(),
  };

  if (withReadStream) {
    fs.readStream = () => {
      counters.opened++;
      return Promise.resolve(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            counters.cancelled++;
          },
        }),
      );
    };
  }

  return fs;
}

describe('review regression — HEAD must not open a body stream', () => {
  it('opens no stream for a HEAD on a file above maxBufferBytes', async () => {
    const counters = { opened: 0, cancelled: 0, stats: 0 };
    const handler = createStaticHandler({
      fs: makeFs({ '/srv/big.bin': { size: 10_000_000 } }, counters),
      root: '/srv',
      urlPrefix: '/',
      index: 'index.html',
      maxBufferBytes: 1024,
    });

    const { ctx, captured } = makeCtx('HEAD', '/big.bin');
    await handler(ctx);

    // Without the fix the stream is opened and then dropped unread: one leaked
    // descriptor per HEAD request.
    expect(counters.opened).toBe(0);
    expect(captured.status).toBe(200);
    expect(captured.streamed).toBe(false);
    expect(captured.headers.get('Content-Length')).toBe('10000000');
  });

  it('opens no stream for a HEAD carrying a Range', async () => {
    const counters = { opened: 0, cancelled: 0, stats: 0 };
    const handler = createStaticHandler({
      fs: makeFs({ '/srv/big.bin': { size: 10_000_000 } }, counters),
      root: '/srv',
      urlPrefix: '/',
      index: 'index.html',
      maxBufferBytes: 1024,
    });

    const { ctx, captured } = makeCtx('HEAD', '/big.bin', { Range: 'bytes=0-99' });
    await handler(ctx);

    expect(counters.opened).toBe(0);
    expect(captured.status).toBe(206);
    expect(captured.headers.get('Content-Range')).toBe('bytes 0-99/10000000');
  });

  it('still streams the body for an equivalent GET', async () => {
    const counters = { opened: 0, cancelled: 0, stats: 0 };
    const handler = createStaticHandler({
      fs: makeFs({ '/srv/big.bin': { size: 10_000_000 } }, counters),
      root: '/srv',
      urlPrefix: '/',
      index: 'index.html',
      maxBufferBytes: 1024,
    });

    const { ctx, captured } = makeCtx('GET', '/big.bin');
    await handler(ctx);

    expect(counters.opened).toBe(1);
    expect(captured.streamed).toBe(true);
  });
});

describe('review regression — Cache-Control follows the original resource', () => {
  const HASHED = '/srv/index-a1b2c3d4.js';

  it('keeps immutable when the brotli sidecar is served', async () => {
    const counters = { opened: 0, cancelled: 0, stats: 0 };
    const handler = createStaticHandler({
      fs: makeFs({ [HASHED]: { size: 10 }, [`${HASHED}.br`]: { size: 5 } }, counters),
      root: '/srv',
      urlPrefix: '/',
      index: 'index.html',
    });

    const { ctx, captured } = makeCtx('GET', '/index-a1b2c3d4.js', {
      'Accept-Encoding': 'br',
    });
    await handler(ctx);

    // Without the fix this is `public, max-age=0, must-revalidate`, because the
    // sidecar path `…-a1b2c3d4.js.br` does not match the content-hash pattern.
    expect(captured.headers.get('Content-Encoding')).toBe('br');
    expect(captured.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('agrees with the identity response for the same asset', async () => {
    const counters = { opened: 0, cancelled: 0, stats: 0 };
    const handler = createStaticHandler({
      fs: makeFs({ [HASHED]: { size: 10 } }, counters),
      root: '/srv',
      urlPrefix: '/',
      index: 'index.html',
    });

    const { ctx, captured } = makeCtx('GET', '/index-a1b2c3d4.js');
    await handler(ctx);

    expect(captured.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('passes the ROOT-RELATIVE path to a cacheControl function', async () => {
    const counters = { opened: 0, cancelled: 0, stats: 0 };
    const seen: string[] = [];
    const handler = createStaticHandler({
      fs: makeFs({ '/srv/assets/app.js': { size: 3 } }, counters),
      root: '/srv',
      urlPrefix: '/',
      index: 'index.html',
      cacheControl: (p: string) => {
        seen.push(p);
        return 'custom';
      },
    });

    const { ctx } = makeCtx('GET', '/assets/app.js');
    await handler(ctx);

    // Without the fix this is the absolute '/srv/assets/app.js', which both
    // breaks the documented contract and leaks the server's directory layout.
    expect(seen).toEqual(['assets/app.js']);
  });

  it('passes the index path relative to the root when a directory resolves', async () => {
    const counters = { opened: 0, cancelled: 0, stats: 0 };
    const seen: string[] = [];
    const handler = createStaticHandler({
      fs: makeFs({
        '/srv/docs': { size: 0, isDirectory: true },
        '/srv/docs/index.html': { size: 5 },
      }, counters),
      root: '/srv',
      urlPrefix: '/',
      index: 'index.html',
      cacheControl: (p: string) => {
        seen.push(p);
        return 'custom';
      },
    });

    const { ctx } = makeCtx('GET', '/docs');
    await handler(ctx);

    expect(seen).toEqual(['docs/index.html']);
  });
});

describe('review regression — the sidecar is stat-ed once', () => {
  it('does not re-stat the sidecar it already resolved', async () => {
    const counters = { opened: 0, cancelled: 0, stats: 0 };
    const handler = createStaticHandler({
      fs: makeFs({ '/srv/app.js': { size: 10 }, '/srv/app.js.br': { size: 5 } }, counters),
      root: '/srv',
      urlPrefix: '/',
      index: 'index.html',
    });

    const { ctx } = makeCtx('GET', '/app.js', { 'Accept-Encoding': 'br' });
    await handler(ctx);

    // One stat for the original + one for the .br sidecar. A third means the
    // sidecar was stat-ed twice for a single request.
    expect(counters.stats).toBe(2);
  });
});

describe('review regression — explicit q=0 beats the wildcard', () => {
  it('refuses brotli when it is explicitly rejected alongside a wildcard', () => {
    expect(isEncodingAcceptable('br;q=0, *', 'br')).toBe(false);
  });

  it('still accepts an encoding covered only by the wildcard', () => {
    expect(isEncodingAcceptable('br;q=0, *', 'gz')).toBe(true);
  });

  it('accepts an explicitly listed encoding', () => {
    expect(isEncodingAcceptable('br, gzip', 'br')).toBe(true);
  });
});

describe('review regression — suffix range on an empty representation', () => {
  it('is unsatisfiable rather than producing a negative end offset', () => {
    // Without the fix this is `{ start: 0, end: -1 }`, which renders as
    // `Content-Range: bytes 0--1/0`.
    expect(parseRange('bytes=-500', 0)).toBe(null);
  });

  it('still resolves a suffix range against a non-empty file', () => {
    expect(parseRange('bytes=-2', 10)).toEqual({ start: 8, end: 9 });
  });
});

describe('review regression — an interrupted download actually resumes', () => {
  const MTIME = new Date('2026-01-01T00:00:00.000Z');

  /** A filesystem whose stat reports an mtime, as every real adapter does. */
  function fsWithMtime(
    counters: { opened: number; cancelled: number; stats: number },
  ): IFileSystem {
    return {
      readFile: () => Promise.resolve(new Uint8Array(1000)),
      writeFile: () => Promise.resolve(),
      stat: () => {
        counters.stats++;
        return Promise.resolve({ isFile: true, isDirectory: false, size: 1000, mtime: MTIME });
      },
      readdir: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
    };
  }

  it('honours If-Range carrying the ETag the server itself issued', async () => {
    const counters = { opened: 0, cancelled: 0, stats: 0 };
    const handler = createStaticHandler({
      fs: fsWithMtime(counters),
      root: '/srv',
      urlPrefix: '/',
      index: 'index.html',
    });

    // 1. The client downloads and records the validator it was given.
    const first = makeCtx('GET', '/big.iso');
    await handler(first.ctx);
    const issued = first.captured.headers.get('ETag');
    expect(issued).toBe('"1000-1767225600000"');

    // 2. The transfer drops; the client resumes with exactly that validator.
    const resumed = makeCtx('GET', '/big.iso', {
      Range: 'bytes=500-',
      'If-Range': issued!,
    });
    await handler(resumed.ctx);

    // Without a strong validator the server ignores If-Range and answers 200,
    // restarting the download from byte zero — the whole point of Range support.
    expect(resumed.captured.status).toBe(206);
    expect(resumed.captured.headers.get('Content-Range')).toBe('bytes 500-999/1000');
  });

  it('still refuses a range when If-Range does not match the current file', async () => {
    const counters = { opened: 0, cancelled: 0, stats: 0 };
    const handler = createStaticHandler({
      fs: fsWithMtime(counters),
      root: '/srv',
      urlPrefix: '/',
      index: 'index.html',
    });

    const stale = makeCtx('GET', '/big.iso', {
      Range: 'bytes=500-',
      'If-Range': '"1000-1600000000000"',
    });
    await handler(stale.ctx);

    // The representation changed under the client, so it must take the whole file.
    expect(stale.captured.status).toBe(200);
  });
});
