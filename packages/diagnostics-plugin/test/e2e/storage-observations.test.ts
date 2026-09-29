/**
 * End-to-end canary for storage operation counters (M98m): a REAL Deno
 * socket, the REAL kernel application and runtime-owned listener, two REAL
 * StoragePlugin instances (one opted in, one not), and the signed native
 * client.
 *
 * Canaries are planted in every place the minimization seam must never
 * reach — the object path, the stored bytes, a content type, a signed URL
 * (the synthetic memory:// URL encodes the path) and a thrown error's
 * message — and asserted absent at the source snapshot, the RAW signed wire
 * bytes, and the client DTO. The approved counters are asserted PRESENT
 * alongside, so dropping every record cannot pass.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IStorage, IStorageDiagnosticsSource } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { StoragePlugin, StorageService } from '@setu-ts/storage-plugin';

import { createDiagnosticsClient, DiagnosticsPlugin } from '../../src/index.ts';
import { TEST_KEY_BYTES, TEST_SESSION_ID } from '../fixtures/helpers.ts';

const CANARY_PATH = 'canary-object-SYNTHETIC';
const CANARY_CONTENT_TYPE = 'canary-type-SYNTHETIC';
const CANARY_BYTES = new TextEncoder().encode('canary-bytes-SYNTHETIC');

/** A fetch that records every raw response body the client receives. */
function capturingFetch(frames: string[]): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    frames.push(await response.clone().text());
    return response;
  };
}

/** Reserves a free loopback port. */
function freePort(): number {
  const probe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  return port;
}

describe('Storage observations e2e (M98m canary)', () => {
  it('serves approved counters end to end while every canary stays absent', async () => {
    const connectorPort = freePort();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiagnosticsPlugin({
          enabled: true,
          port: connectorPort,
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_KEY_BYTES,
        }),
        StoragePlugin({
          provider: 'memory',
          diagnostics: { enabled: true, alias: 'primary' },
        }),
      ],
      diagnostics: {},
    });
    await app.start({ port: freePort(), hostname: '127.0.0.1' });
    try {
      const storage = app.services.get<IStorage>(CAPABILITIES.STORAGE);
      // A service constructed directly carries no collector: its work never
      // appears in any source. (Two StoragePlugin instances cannot coexist —
      // they share the single storage token.)
      const other = new StorageService(
        {
          connect: () => Promise.resolve(),
          disconnect: () => Promise.resolve(),
          isReady: () => true,
          put: () => Promise.resolve(),
          get: () => Promise.resolve(new Uint8Array([1])),
          delete: () => Promise.resolve(true),
          exists: () => Promise.resolve(true),
          getSignedUrl: () => Promise.resolve('memory://unobserved'),
        } as never,
      );

      // Every public operation settles through the observed service.
      await storage.put(CANARY_PATH, CANARY_BYTES, { contentType: CANARY_CONTENT_TYPE });
      expect(await storage.get(CANARY_PATH)).toEqual(CANARY_BYTES);
      expect(await storage.exists(CANARY_PATH)).toBe(true);
      const url = await storage.getSignedUrl(CANARY_PATH, { expiresIn: 60 });
      expect(url.startsWith('memory://')).toBe(true);
      // The registered service (StorageService) always provides getStream,
      // though the IStorage interface marks it optional.
      const getStream = storage.getStream?.bind(storage);
      expect(getStream).toBeDefined();
      const stream = await getStream!(CANARY_PATH);
      const reader = stream.getReader();
      const chunk = (await reader.read()).value;
      expect(chunk).toEqual(CANARY_BYTES);
      expect(await storage.delete(CANARY_PATH)).toBe(true);
      expect(await storage.delete(CANARY_PATH)).toBe(false);
      // The absent-object conversion is a failed settlement, not a throw.
      await expect(storage.get('absent-SYNTHETIC')).rejects.toThrow('not found');
      // The unobserved instance's work never appears anywhere.
      await other.put('ignored', new Uint8Array([1]));

      const frames: string[] = [];
      const client = createDiagnosticsClient({
        endpoint: `http://127.0.0.1:${connectorPort}`,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
        subtle: crypto.subtle,
        fetch: capturingFetch(frames),
        timing: { setTimeout, clearTimeout },
      });
      const response = await client.storage();
      client.close();

      // --- Approved counters survive (positive control) ---------------
      expect(response.state).toEqual('ready');
      expect(response.sources.map((s) => s.sourceId)).toEqual(['s1']);
      const [primary] = response.sources;
      expect(primary!.snapshot.alias).toEqual('primary');
      expect(primary!.snapshot.coverage).toEqual('owned-instance');
      const byOp = new Map(primary!.snapshot.records.map((r) => [r.operation, r]));
      expect(byOp.get('put')).toMatchObject({
        count: 1,
        succeeded: 1,
        lastBytes: CANARY_BYTES.length,
      });
      expect(byOp.get('get')).toMatchObject({ count: 2, succeeded: 1, failed: 1 });
      expect(byOp.get('exists')).toMatchObject({ count: 1, succeeded: 1 });
      expect(byOp.get('delete')).toMatchObject({ count: 2, succeeded: 2 });
      expect(byOp.get('getSignedUrl')).toMatchObject({
        count: 1,
        succeeded: 1,
        lastDurationMs: null,
        lastBytes: null,
      });
      expect(byOp.get('getStream')).toMatchObject({ count: 1, succeeded: 1 });

      const sources = app.services.getAll<IStorageDiagnosticsSource>(
        CAPABILITIES.STORAGE_DIAGNOSTICS,
      );
      const local = JSON.stringify(sources.map((s) => s.snapshot()));
      expect(local).toContain('primary');

      // --- Canaries are absent at every layer -------------------------
      const canaries = [
        CANARY_PATH,
        CANARY_CONTENT_TYPE,
        'canary-bytes-SYNTHETIC',
        'memory://',
        'absent-SYNTHETIC',
        'ignored',
      ];
      expect(frames.length).toBeGreaterThan(0);
      for (const layer of [local, JSON.stringify(response), ...frames]) {
        for (const canary of canaries) {
          expect(layer).not.toContain(canary);
        }
      }
    } finally {
      await app.stop();
    }
  });
});
