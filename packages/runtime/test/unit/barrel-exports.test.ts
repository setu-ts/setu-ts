/**
 * Barrel export test — asserts every documented export from src/index.ts
 * is present and every removed export is gone.
 *
 * @module
 */

import * as barrel from '../../src/index.ts';
import { describe, expect, it } from 'vitest';
import type { NodeServeHost, DenoServeHost, BunServer } from '../../src/index.ts';

describe('proxy peer host types from the barrel', () => {
  it('accepts native peer callbacks and keeps normalization internal', async () => {
    const nodeFetch: Parameters<NodeServeHost['serve']>[0]['fetch'] = (_request, env) =>
      new Response(env?.incoming?.socket?.remoteAddress ?? 'absent');
    const denoFetch: Parameters<DenoServeHost['serve']>[0]['fetch'] = (_request, info) =>
      new Response(info?.remoteAddr?.hostname ?? 'absent');
    const server: BunServer = { stop() {}, requestIP: () => ({ address: '192.0.2.3' }) };
    const request = new Request('http://localhost/');
    expect(
      await (
        await nodeFetch(request, { incoming: { socket: { remoteAddress: undefined } } })
      ).text(),
    ).toBe('absent');
    expect(
      await (
        await nodeFetch(request, { incoming: { socket: { remoteAddress: '192.0.2.1' } } })
      ).text(),
    ).toBe('192.0.2.1');
    expect(await (await denoFetch(request, { remoteAddr: { hostname: '192.0.2.2' } })).text()).toBe(
      '192.0.2.2',
    );
    expect(server.requestIP?.(request)?.address).toBe('192.0.2.3');
    expect('normalizePeerAddress' in barrel).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Present exports (values)
// ---------------------------------------------------------------------------

describe('barrel-exports | present exports', () => {
  it('RuntimePlugin is exported', () => {
    expect(typeof barrel.RuntimePlugin).toBe('function');
  });

  it('detectRuntime is exported', () => {
    expect(typeof barrel.detectRuntime).toBe('function');
  });

  it('createRuntimeServices is exported', () => {
    expect(typeof barrel.createRuntimeServices).toBe('function');
  });

  it('createDenoRuntimeServices is exported', () => {
    expect(typeof barrel.createDenoRuntimeServices).toBe('function');
  });

  it('buildNodeHost is exported', () => {
    expect(typeof barrel.buildNodeHost).toBe('function');
  });

  it('createNodeRuntimeServices is exported', () => {
    expect(typeof barrel.createNodeRuntimeServices).toBe('function');
  });

  it('createBunRuntimeServices is exported', () => {
    expect(typeof barrel.createBunRuntimeServices).toBe('function');
  });

  it('createCloudflareRuntimeServices is exported', () => {
    expect(typeof barrel.createCloudflareRuntimeServices).toBe('function');
  });

  it('DenoHttpAdapter is exported', () => {
    expect(typeof barrel.DenoHttpAdapter).toBe('function');
  });

  it('NodeHttpAdapter is exported', () => {
    expect(typeof barrel.NodeHttpAdapter).toBe('function');
  });

  it('BunHttpAdapter is exported', () => {
    expect(typeof barrel.BunHttpAdapter).toBe('function');
  });

  it('CloudflareWorkersHttpAdapter is exported', () => {
    expect(typeof barrel.CloudflareWorkersHttpAdapter).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Removed exports (deleted mapping files — should NOT be present)
// ---------------------------------------------------------------------------

describe('barrel-exports | removed exports', () => {
  it('mapNodeRequest is NOT exported', () => {
    expect('mapNodeRequest' in barrel).toBe(false);
  });

  it('mapDenoRequest is NOT exported', () => {
    expect('mapDenoRequest' in barrel).toBe(false);
  });

  it('mapBunRequest is NOT exported', () => {
    expect('mapBunRequest' in barrel).toBe(false);
  });

  it('writeSnapshotToNodeResponse is NOT exported', () => {
    expect('writeSnapshotToNodeResponse' in barrel).toBe(false);
  });

  it('mapSnapshotToDenoResponse is NOT exported', () => {
    expect('mapSnapshotToDenoResponse' in barrel).toBe(false);
  });

  it('mapSnapshotToBunResponse is NOT exported', () => {
    expect('mapSnapshotToBunResponse' in barrel).toBe(false);
  });
});
