/**
 * Connect real-import test — guarded REAL import of all four Connect-ES modules
 * through `loadConnectModule()`, exercising the real `createConnectRuntime`
 * closures (createConnectRouter, createFetchHandler, reviveDescriptorSet,
 * getService, createRegistry) against the genuine @bufbuild/protobuf /
 * @connectrpc/connect modules. Skipped when the modules are absent.
 *
 * This is the "guarded real-import test" named in the milestone plan (§3.2) and
 * also covers the `createRegistry` closure that is otherwise unused by src.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { loadConnectModule, resetModuleCache } from '../../src/transports/connect-loader.ts';
import { ECHO_DESCRIPTOR_BASE64 } from '../fixtures/echo-descriptors.ts';

// Guarded real import of @bufbuild/protobuf — used only to build a FileDescriptorSet
// message so the createRegistry closure can be exercised directly.
let fromBinary: typeof import('npm:@bufbuild/protobuf@^2.7.0').fromBinary;
let FileDescriptorSetSchema:
  typeof import('npm:@bufbuild/protobuf@^2.7.0/wkt').FileDescriptorSetSchema;
let realImportOk = false;
try {
  ({ fromBinary } = await import('npm:@bufbuild/protobuf@^2.7.0'));
  ({ FileDescriptorSetSchema } = await import('npm:@bufbuild/protobuf@^2.7.0/wkt'));
  realImportOk = true;
} catch {
  realImportOk = false;
}

const describeOrSkip = realImportOk ? describe : describe.skip;

describeOrSkip('Connect real import (loadConnectModule)', () => {
  it('revives a real DescService via reviveDescriptorSet + getService', async () => {
    resetModuleCache();
    const runtime = await loadConnectModule();
    const registry = runtime.reviveDescriptorSet(ECHO_DESCRIPTOR_BASE64);
    expect(registry).toBeDefined();
    const svc = runtime.getService(registry, 'example.EchoService');
    expect(svc).toBeDefined();
  });

  it('createRegistry builds a FileRegistry from a FileDescriptorSet', async () => {
    resetModuleCache();
    const runtime = await loadConnectModule();
    // Build a real FileDescriptorSet message, then exercise the createRegistry
    // closure (the only runtime closure not otherwise called by src).
    function b64(b: string): Uint8Array {
      const s = atob(b);
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    }
    const fdSet = fromBinary!(FileDescriptorSetSchema!, b64(ECHO_DESCRIPTOR_BASE64));
    const registry = runtime.createRegistry(fdSet);
    expect(registry).toBeDefined();
    const svc = (registry as { getService: (n: string) => unknown }).getService(
      'example.EchoService',
    );
    expect(svc).toBeDefined();
  });

  it('createConnectRouter + createFetchHandler produce a working fetch handler', async () => {
    resetModuleCache();
    const runtime = await loadConnectModule();
    const registry = runtime.reviveDescriptorSet(ECHO_DESCRIPTOR_BASE64);
    const echoService = runtime.getService(registry, 'example.EchoService');
    expect(echoService).toBeDefined();

    const router = runtime.createConnectRouter();
    expect(Array.isArray(router.handlers)).toBe(true);
    // Register the real service; handlers must be produced for each method.
    router.service(echoService as { typeName: string }, {
      echo: (req: unknown) => ({ response: `echo: ${(req as { message: string }).message}` }),
      ping: () => ({ pong: true }),
    });
    expect(router.handlers.length).toBeGreaterThan(0);
    const echoHandler = router.handlers.find((h) => h.requestPath.includes('/Echo'));
    expect(echoHandler).toBeDefined();

    // createFetchHandler must turn the universal handler into a fetch handler.
    const fetchHandler = runtime.createFetchHandler(
      echoHandler as unknown as (
        request: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>,
    );
    expect(typeof fetchHandler).toBe('function');
    const res = await fetchHandler(
      new Request('http://x/example.EchoService/Echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'real import' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { response: string };
    expect(body).toEqual({ response: 'echo: real import' });
  });
});
