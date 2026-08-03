/**
 * The indicator must never touch a binding — Cloudflare prohibits I/O outside a
 * request, and a KV read per probe interval is billable — so its inputs are
 * plain facts and the off-platform case is the only status it can act on.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createCloudflareIndicator } from '../../../src/health/indicator.ts';

const BASE = {
  bindings: ['CACHE_KV', 'UPLOADS'],
  varCount: 3,
  cache: true,
  storage: true,
  queue: true,
  durableObject: true,
  waitUntil: true,
} as const;

describe('createCloudflareIndicator', () => {
  it('reports up on Workers, with the binding inventory', async () => {
    const indicator = createCloudflareIndicator({ ...BASE, platform: 'cloudflare-workers' });
    const result = await indicator();

    expect(result.status).toBe('up');
    expect(result.data).toEqual({
      platform: 'cloudflare-workers',
      bindings: ['CACHE_KV', 'UPLOADS'],
      vars: 3,
      cache: true,
      storage: true,
      queue: true,
      durableObject: true,
      waitUntil: 'injected',
    });
  });

  it('reports absent when no waitUntil host was injected', async () => {
    const indicator = createCloudflareIndicator({
      ...BASE,
      waitUntil: false,
      platform: 'cloudflare-workers',
    });
    expect((await indicator()).data?.waitUntil).toBe('absent');
  });

  it('reports degraded with a detail when running off Cloudflare Workers', async () => {
    const indicator = createCloudflareIndicator({ ...BASE, platform: 'node' });
    const result = await indicator();

    expect(result.status).toBe('degraded');
    expect(result.data?.platform).toBe('node');
    expect(String(result.data?.detail)).toContain("registered on 'node'");
  });

  it('carries no detail on the healthy path', async () => {
    const indicator = createCloudflareIndicator({ ...BASE, platform: 'cloudflare-workers' });
    expect((await indicator()).data).not.toHaveProperty('detail');
  });

  it('reports the capabilities it does not serve as false', async () => {
    const indicator = createCloudflareIndicator({
      bindings: [],
      varCount: 0,
      cache: false,
      storage: false,
      queue: false,
      durableObject: false,
      waitUntil: false,
      platform: 'cloudflare-workers',
    });
    const result = await indicator();

    expect(result.data?.cache).toBe(false);
    expect(result.data?.storage).toBe(false);
    expect(result.data?.queue).toBe(false);
    expect(result.data?.durableObject).toBe(false);
    expect(result.data?.bindings).toEqual([]);
  });
});
