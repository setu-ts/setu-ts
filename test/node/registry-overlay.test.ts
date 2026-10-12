/**
 * Tests for the local npm registry the scaffold-install gates point at.
 *
 * Every case runs a REAL server on loopback, with a fake upstream, so the routes
 * an installer actually requests — the scoped packument in either spelling, the
 * canonical tarball path — are exercised as HTTP, not as function calls.
 *
 * @module
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { packCacheKey, type PackedMember } from '../../scripts/pack-members.ts';
import { PUBLISHED_PACKAGES } from '../../scripts/release-packages.ts';
import {
  DEFAULT_PUBLISHED_AT,
  packument,
  type RegistryOverlay,
  requestedPackage,
  startRegistryOverlay,
  tarballPath,
} from '../../scripts/registry-overlay.ts';
import { tempDir } from '../node-helpers.ts';

const open: RegistryOverlay[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const overlay of open.splice(0)) await overlay.close();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** One packed member backed by a real file. */
async function packOf(bytes = 'tarball-bytes'): Promise<PackedMember> {
  const dir = await tempDir();
  dirs.push(dir);
  const tarball = join(dir, 'setu-ts-common-0.9.0.tgz');
  await fs.writeFile(tarball, bytes);
  return {
    name: '@setu-ts/common',
    version: '0.9.0',
    tarball,
    manifest: { name: '@setu-ts/common', version: '0.9.0', type: 'module' },
  };
}

/** A recording upstream answering every request with `status` and `body`. */
function upstream(
  status = 200,
  body = '{"from":"upstream"}',
  contentType: string | null = 'application/json',
) {
  const seen: { url: string; accept: string | null }[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    seen.push({ url, accept: new Headers(init?.headers).get('accept') });
    const headers = contentType === null ? undefined : { 'content-type': contentType };
    // Bytes, not a string: a string body makes `Response` invent a text type.
    return Promise.resolve(
      new Response(new TextEncoder().encode(body), { status, ...(headers ? { headers } : {}) }),
    );
  }) as typeof fetch;
  return { seen, fetchImpl };
}

/** Starts an overlay and remembers to close it. */
async function start(
  options: Parameters<typeof startRegistryOverlay>[0],
): Promise<RegistryOverlay> {
  const overlay = await startRegistryOverlay(options);
  open.push(overlay);
  return overlay;
}

describe('tarballPath', () => {
  it('is the public registry route for a scoped package', () => {
    expect(tarballPath('@setu-ts/common', '0.9.0')).toBe('/@setu-ts/common/-/common-0.9.0.tgz');
  });
});

describe('requestedPackage', () => {
  it('reads a framework packument request in either spelling', () => {
    expect(requestedPackage('/@setu-ts/common')).toBe('@setu-ts/common');
    expect(requestedPackage('/@setu-ts%2fcommon')).toBe('@setu-ts/common');
    expect(requestedPackage('/@setu-ts%2Fcommon')).toBe('@setu-ts/common');
  });

  it('ignores everything else, including a malformed escape', () => {
    expect(requestedPackage('/react')).toBeUndefined();
    expect(requestedPackage('/@other/x')).toBeUndefined();
    expect(requestedPackage('/@setu-ts/common/-/common-0.9.0.tgz')).toBeUndefined();
    expect(requestedPackage('/%E0%A4%A')).toBeUndefined();
  });
});

describe('packument', () => {
  it('advertises the canonical tarball with its integrity and time', async () => {
    const pack = await packOf();
    const doc = packument(pack, 'http://127.0.0.1:1/', { shasum: 's', integrity: 'i' }, 'T');
    expect(doc).toEqual({
      name: '@setu-ts/common',
      'dist-tags': { latest: '0.9.0' },
      versions: {
        '0.9.0': {
          name: '@setu-ts/common',
          version: '0.9.0',
          type: 'module',
          dist: {
            tarball: 'http://127.0.0.1:1/@setu-ts/common/-/common-0.9.0.tgz',
            shasum: 's',
            integrity: 'i',
          },
        },
      },
      time: { created: 'T', modified: 'T', '0.9.0': 'T' },
    });
  });
});

describe('startRegistryOverlay', () => {
  it('serves a packument whose tarball and integrity match the bytes it serves', async () => {
    const pack = await packOf('real bytes');
    const overlay = await start({
      packs: new Map([[pack.name, pack]]),
      fetch: upstream().fetchImpl,
    });
    expect(overlay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(overlay.packs.get('@setu-ts/common')).toBe(pack);

    const doc = await (await fetch(`${overlay.url}@setu-ts%2fcommon`)).json() as {
      versions: Record<string, { dist: { tarball: string; shasum: string; integrity: string } }>;
      time: Record<string, string>;
    };
    const dist = doc.versions['0.9.0']!.dist;
    expect(dist.tarball).toBe(`${overlay.url}@setu-ts/common/-/common-0.9.0.tgz`);
    expect(doc.time['0.9.0']).toBe(DEFAULT_PUBLISHED_AT);

    const response = await fetch(dist.tarball);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.toString()).toBe('real bytes');
    expect(dist.shasum).toBe(createHash('sha1').update(bytes).digest('hex'));
    expect(dist.integrity).toBe(`sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  });

  // Codex review (M111d): a lockfile resolved against npm names the canonical
  // route, and the overlay used to proxy it upstream, where the tree's own
  // version does not exist. The scope separator may arrive encoded.
  it('serves its own tarball at the canonical route in either spelling', async () => {
    const pack = await packOf('bytes');
    const remote = upstream();
    const overlay = await start({ packs: new Map([[pack.name, pack]]), fetch: remote.fetchImpl });
    for (
      const path of ['@setu-ts/common/-/common-0.9.0.tgz', '@setu-ts%2fcommon/-/common-0.9.0.tgz']
    ) {
      expect(await (await fetch(`${overlay.url}${path}`)).text(), path).toBe('bytes');
    }
    expect(remote.seen).toEqual([]);
  });

  it('stamps the current time when asked to', async () => {
    const pack = await packOf();
    const overlay = await start({
      packs: new Map([[pack.name, pack]]),
      publishedAt: 'now',
      fetch: upstream().fetchImpl,
    });
    const doc = await (await fetch(`${overlay.url}@setu-ts/common`)).json() as {
      time: Record<string, string>;
    };
    expect(Date.parse(doc.time['0.9.0']!)).toBeGreaterThan(Date.parse('2026-01-01'));
  });

  it('refuses a framework package it does not serve rather than proxying it', async () => {
    const remote = upstream();
    const overlay = await start({ packs: new Map(), fetch: remote.fetchImpl });
    const response = await fetch(`${overlay.url}@setu-ts/kernel`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: '@setu-ts/kernel is not served by this overlay',
    });
    expect(remote.seen).toEqual([]);
  });

  it('proxies everything else upstream, preserving status, type and accept', async () => {
    const pack = await packOf();
    const remote = upstream(201, 'binary', 'application/x-tar');
    const overlay = await start({
      packs: new Map([[pack.name, pack]]),
      fetch: remote.fetchImpl,
      upstream: 'https://upstream.test',
    });
    // Another version of a framework package is the public registry's to serve.
    for (const path of ['react?write=true', '@setu-ts/common/-/common-0.8.0.tgz']) {
      const response = await fetch(`${overlay.url}${path}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
      });
      expect(response.status).toBe(201);
      expect(response.headers.get('content-type')).toBe('application/x-tar');
      expect(await response.text()).toBe('binary');
    }
    expect(remote.seen).toEqual([
      {
        url: 'https://upstream.test/react?write=true',
        accept: 'application/vnd.npm.install-v1+json',
      },
      {
        url: 'https://upstream.test/@setu-ts/common/-/common-0.8.0.tgz',
        accept: 'application/vnd.npm.install-v1+json',
      },
    ]);
  });

  it('defaults a missing accept and content type when proxying', async () => {
    const remote = upstream(200, 'x', null);
    const overlay = await start({ packs: new Map(), fetch: remote.fetchImpl });
    const response = await new Promise<{ type: string | undefined }>((resolve, reject) => {
      // A raw request carries no accept header at all, unlike `fetch`.
      import('node:http').then(({ get }) =>
        get(`${overlay.url}left-pad`, (res) => {
          res.resume();
          res.on('end', () => resolve({ type: res.headers['content-type'] }));
        }).on('error', reject)
      ).catch(reject);
    });
    expect(remote.seen[0]!.accept).toBe('application/json');
    expect(response.type).toBe('application/octet-stream');
  });

  it('forwards a path it cannot decode as sent', async () => {
    const remote = upstream();
    const overlay = await start({
      packs: new Map(),
      fetch: remote.fetchImpl,
      upstream: 'https://u.test',
    });
    await (await fetch(`${overlay.url}%E0%A4%A`)).text();
    expect(remote.seen.map((call) => call.url)).toEqual(['https://u.test/%E0%A4%A']);
  });

  it('forwards to the public registry by default', async () => {
    const remote = upstream();
    const overlay = await start({ packs: new Map(), fetch: remote.fetchImpl });
    await (await fetch(`${overlay.url}react`)).text();
    expect(remote.seen.map((call) => call.url)).toEqual(['https://registry.npmjs.org/react']);
  });

  it('proxies through the global fetch when none is injected', async () => {
    const remote = await start({
      packs: new Map(),
      fetch: upstream(200, 'from the far side').fetchImpl,
    });
    const overlay = await start({ packs: new Map(), upstream: remote.url.slice(0, -1) });
    expect(await (await fetch(`${overlay.url}anything`)).text()).toBe('from the far side');
  });

  it('builds its packs from a repository root', async () => {
    const root = await tempDir();
    dirs.push(root);
    const pack = await packOf('from the cache');
    const self = new URL('../../scripts/pack-members.ts', import.meta.url).pathname;
    const key = await packCacheKey(root, PUBLISHED_PACKAGES, self);
    await fs.mkdir(join(root, '.tmp/overlay', key), { recursive: true });
    await fs.writeFile(join(root, '.tmp/overlay', key, 'packs.json'), JSON.stringify([pack]));
    const overlay = await start({ root, fetch: upstream().fetchImpl });
    expect([...overlay.packs.keys()]).toEqual(['@setu-ts/common']);
    expect(await (await fetch(`${overlay.url}@setu-ts/common/-/common-0.9.0.tgz`)).text())
      .toBe('from the cache');
  });

  it('answers 502 naming the failure when upstream is unreachable', async () => {
    for (const failure of [new Error('ECONNREFUSED'), 'plain']) {
      const overlay = await start({
        packs: new Map(),
        fetch: (() => Promise.reject(failure)) as typeof fetch,
      });
      const response = await fetch(`${overlay.url}react`);
      expect(response.status).toBe(502);
      expect(await response.text()).toBe(
        `registry overlay: ${failure instanceof Error ? failure.message : failure}`,
      );
    }
  });
});
