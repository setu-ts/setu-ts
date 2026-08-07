/**
 * The plugin descriptor itself — everything observable before `register()` runs.
 *
 * `provides` is computed from the options rather than declared statically, and
 * the kernel's duplicate-provider index reads it, so getting it wrong turns a
 * startup error into a load-order coin flip.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';

import { CloudflarePlugin } from '../../../src/index.ts';

const ENV = { CACHE_KV: {}, UPLOADS: {} };

describe('CloudflarePlugin descriptor', () => {
  it('names itself after the package and runs in the HIGH band', () => {
    const plugin = CloudflarePlugin({ env: ENV });

    expect(plugin.name).toBe('cloudflare-plugin');
    // HIGH, so bindings exist before ordinary capability plugins register.
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.HIGH);
    expect(plugin.optionalDependencies).toEqual(['logger']);
  });

  it('provides only the bindings token when no capability arm is configured', () => {
    expect(CloudflarePlugin({ env: ENV }).provides).toEqual([CAPABILITIES.CLOUDFLARE]);
  });

  it('claims the bare cache token for the default instance', () => {
    const plugin = CloudflarePlugin({ env: ENV, cache: { binding: 'CACHE_KV' } });
    expect(plugin.provides).toEqual([CAPABILITIES.CLOUDFLARE, 'cache']);
  });

  it('claims the bare storage token for the default instance', () => {
    const plugin = CloudflarePlugin({ env: ENV, storage: { binding: 'UPLOADS' } });
    expect(plugin.provides).toEqual([CAPABILITIES.CLOUDFLARE, 'storage']);
  });

  it('derives a namespaced token for a named instance', () => {
    const plugin = CloudflarePlugin({
      env: ENV,
      cache: { binding: 'CACHE_KV', name: 'edge' },
      storage: { binding: 'UPLOADS', name: 'assets' },
    });
    expect(plugin.provides).toEqual([CAPABILITIES.CLOUDFLARE, 'cache.edge', 'storage.assets']);
  });

  it("treats an explicit 'default' name as the bare token", () => {
    const plugin = CloudflarePlugin({ env: ENV, cache: { binding: 'CACHE_KV', name: 'default' } });
    expect(plugin.provides).toEqual([CAPABILITIES.CLOUDFLARE, 'cache']);
  });

  it('rejects an instance name the token grammar forbids', () => {
    // createCapabilityToken enforces lowercase kebab-case; a colon is illegal.
    expect(() => CloudflarePlugin({ env: ENV, cache: { binding: 'K', name: 'Edge:1' } }))
      .toThrow(TypeError);
  });

  it('claims the bare realtime-backplane token for the default instance', () => {
    const plugin = CloudflarePlugin({ env: ENV, durableObject: { binding: 'REALTIME' } });
    expect(plugin.provides).toEqual([CAPABILITIES.CLOUDFLARE, CAPABILITIES.REALTIME_BACKPLANE]);
  });

  it('derives a namespaced realtime-backplane token for a named instance', () => {
    const plugin = CloudflarePlugin({
      env: ENV,
      durableObject: { binding: 'REALTIME', name: 'chat' },
    });
    expect(plugin.provides).toEqual([CAPABILITIES.CLOUDFLARE, 'realtime-backplane.chat']);
  });

  it('provides nothing extra when the durableObject arm is omitted', () => {
    expect(CloudflarePlugin({ env: ENV }).provides).not.toContain(
      CAPABILITIES.REALTIME_BACKPLANE,
    );
  });
});
