/**
 * Unit tests for the Connect runtime loader: the pure `adaptConnectModule`
 * adapter and the per-specifier failure branches of `loadConnectModule`, driven
 * through the injected per-key importers so no network is required.
 *
 * The final test asserts each DEFAULT importer's source is a literal
 * `import('npm:…')`. That is the replacement for the old assertion that only
 * checked `String(defaultImporter)` contained `import(` — a stringified
 * non-literal `import(specifier)` also contains `import(`, so the old test
 * passed while the published artifact shipped `npm:` verbatim and could not
 * load on Node or Bun (X7-3). The literal-argument property is what survives
 * JSR's static npm-compatibility rewrite.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  adaptConnectModule,
  type ConnectImporters,
  type ConnectModuleLike,
  DEFAULT_IMPORTERS,
  loadConnectModule,
} from '../../src/transports/connect-loader.ts';
import { GrpcDescriptorError, GrpcRuntimeLoadError } from '../../src/errors/grpc-errors.ts';
import { fakeFile, fakeService } from '../fixtures/fake-connect-runtime.ts';
import type { FileRegistryLike } from '../../src/interfaces/connect-runtime.ts';

/** Records every call the adapter makes into the fake modules. */
interface Calls {
  createConnectRouter: number;
  createFetchHandler: unknown[];
  fromBinary: unknown[];
  toBinary: unknown[];
  createFileRegistry: unknown[];
}

function createFakeModules(
  overrides: { fromBinaryThrows?: boolean } = {},
): { modules: ConnectModuleLike; calls: Calls } {
  const calls: Calls = {
    createConnectRouter: 0,
    createFetchHandler: [],
    fromBinary: [],
    toBinary: [],
    createFileRegistry: [],
  };

  const registry: FileRegistryLike = {
    files: [],
    getService: (name) => (name === 'pkg.Svc' ? fakeService('pkg.Svc') : undefined),
  };

  const modules: ConnectModuleLike = {
    connect: {
      createConnectRouter: () => {
        calls.createConnectRouter++;
        return { handlers: [], service: () => undefined };
      },
    },
    protocol: {
      createFetchHandler: (handler) => {
        calls.createFetchHandler.push(handler);
        return () => Promise.resolve(new Response('ok'));
      },
    },
    protobuf: {
      createFileRegistry: (fdSet) => {
        calls.createFileRegistry.push(fdSet);
        return registry;
      },
      fromBinary: (schema, bytes) => {
        calls.fromBinary.push({ schema, byteLength: bytes.length });
        if (overrides.fromBinaryThrows === true) {
          throw new Error('not a FileDescriptorSet');
        }
        return { decoded: true };
      },
      toBinary: (schema, message) => {
        calls.toBinary.push({ schema, message });
        return new Uint8Array([1, 2, 3]);
      },
    },
    wkt: {
      FileDescriptorSetSchema: 'FileDescriptorSetSchema',
      FileDescriptorProtoSchema: 'FileDescriptorProtoSchema',
    },
  };

  return { modules, calls };
}

describe('adaptConnectModule', () => {
  it('delegates createConnectRouter to the connect module', () => {
    const { modules, calls } = createFakeModules();
    adaptConnectModule(modules).createConnectRouter();
    expect(calls.createConnectRouter).toBe(1);
  });

  it('delegates createFetchHandler to the protocol subpath, not the core module', () => {
    const { modules, calls } = createFakeModules();
    const handler = { requestPath: '/pkg.Svc/Method' };
    adaptConnectModule(modules).createFetchHandler(handler);
    expect(calls.createFetchHandler).toEqual([handler]);
  });

  it('leaves httpVersion unset so Connect does not refuse bidi streams', () => {
    // Connect refuses a bidi method with 505 when httpVersion starts with '1.'.
    // The plugin cannot know the negotiated version, so it must pass no option.
    const { modules } = createFakeModules();
    let received: unknown = 'not-called';
    modules.protocol.createFetchHandler = (_handler, options) => {
      received = options;
      return () => Promise.resolve(new Response('ok'));
    };
    adaptConnectModule(modules).createFetchHandler({ requestPath: '/x/Y' });
    expect(received).toBeUndefined();
  });

  it('revives a descriptor set through fromBinary then createFileRegistry', () => {
    const { modules, calls } = createFakeModules();
    const runtime = adaptConnectModule(modules);
    const registry = runtime.reviveDescriptorSet(btoa('hello'));

    expect(calls.fromBinary).toEqual([{ schema: 'FileDescriptorSetSchema', byteLength: 5 }]);
    expect(calls.createFileRegistry).toEqual([{ decoded: true }]);
    expect(runtime.getService(registry, 'pkg.Svc')?.typeName).toBe('pkg.Svc');
    expect(runtime.getService(registry, 'absent.Svc')).toBeUndefined();
  });

  it('wraps a decode failure in GrpcDescriptorError, preserving the cause', () => {
    const { modules } = createFakeModules({ fromBinaryThrows: true });
    let thrown: unknown;
    try {
      adaptConnectModule(modules).reviveDescriptorSet(btoa('junk'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GrpcDescriptorError);
    expect((thrown as Error).message).toContain('FileDescriptorSet');
    expect((thrown as Error).cause).toBeInstanceOf(Error);
  });

  it('serializes a file descriptor with the FileDescriptorProto schema, not the Set schema', () => {
    const { modules, calls } = createFakeModules();
    const file = fakeFile('example/echo.proto');
    const bytes = adaptConnectModule(modules).serializeFileDescriptor(file);

    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls.toBinary).toEqual([
      { schema: 'FileDescriptorProtoSchema', message: file.proto },
    ]);
  });
});

describe('loadConnectModule', () => {
  /** The four specifiers in load order. */
  const SPECIFIERS = [
    'npm:@connectrpc/connect@^2.1.2',
    'npm:@connectrpc/connect@^2.1.2/protocol',
    'npm:@bufbuild/protobuf@^2.7.0',
    'npm:@bufbuild/protobuf@^2.7.0/wkt',
  ];

  /** The specifier each importer key loads, in load order. */
  const SPECIFIER_BY_KEY: Record<keyof ConnectImporters, string> = {
    connect: 'npm:@connectrpc/connect@^2.1.2',
    protocol: 'npm:@connectrpc/connect@^2.1.2/protocol',
    protobuf: 'npm:@bufbuild/protobuf@^2.7.0',
    wkt: 'npm:@bufbuild/protobuf@^2.7.0/wkt',
  };

  /** Per-key importers that resolve every key except the one named. */
  function importersFailing(failing: string): Partial<ConnectImporters> {
    const { modules } = createFakeModules();
    const byKey: Record<keyof ConnectImporters, unknown> = {
      connect: modules.connect,
      protocol: modules.protocol,
      protobuf: modules.protobuf,
      wkt: modules.wkt,
    };
    const importers: Partial<ConnectImporters> = {};
    for (const key of Object.keys(byKey) as Array<keyof ConnectImporters>) {
      const specifier = SPECIFIER_BY_KEY[key];
      importers[key] = specifier === failing
        ? () => Promise.reject(new Error(`Module not found: ${specifier}`))
        : () => Promise.resolve(byKey[key]);
    }
    return importers;
  }

  it('assembles a runtime when all four specifiers resolve', async () => {
    const runtime = await loadConnectModule(importersFailing('none'));
    expect(typeof runtime.createConnectRouter).toBe('function');
    expect(typeof runtime.createFetchHandler).toBe('function');
    expect(typeof runtime.reviveDescriptorSet).toBe('function');
    expect(typeof runtime.getService).toBe('function');
    expect(typeof runtime.serializeFileDescriptor).toBe('function');
  });

  it('uses a per-key override in place of the default importer', async () => {
    // `connect` loads first, so a rejecting override for it surfaces before
    // any default importer runs — proving the override is wired in while
    // keeping the test hermetic.
    let thrown: unknown;
    try {
      await loadConnectModule({
        connect: () => Promise.reject(new Error('override-fail')),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GrpcRuntimeLoadError);
    const error = thrown as GrpcRuntimeLoadError;
    expect(error.specifier).toBe(SPECIFIER_BY_KEY.connect);
    expect((error.cause as Error).message).toBe('override-fail');
  });

  for (const specifier of SPECIFIERS) {
    it(`throws GrpcRuntimeLoadError naming '${specifier}' when it cannot be imported`, async () => {
      let thrown: unknown;
      try {
        await loadConnectModule(importersFailing(specifier));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(GrpcRuntimeLoadError);
      const error = thrown as GrpcRuntimeLoadError;
      expect(error.specifier).toBe(specifier);
      expect(error.message).toContain(specifier);
      // The message must name all three package managers — a Bun project
      // must not be told to run a Deno command.
      expect(error.message).toContain('deno add npm:');
      expect(error.message).toContain('npm i ');
      expect(error.message).toContain('bun add ');
      expect(error.cause).toBeInstanceOf(Error);
    });
  }

  it('keeps each default specifier as a literal import() argument', () => {
    // The old assertion only checked that the stringified default importer
    // contained `import(` — and `(specifier) => import(specifier)` does,
    // which is exactly the shape JSR's static rewrite cannot see, so the
    // published artifact shipped `npm:` verbatim (X7-3). The property that
    // survives publish is that the argument is a quoted literal.
    for (const key of Object.keys(SPECIFIER_BY_KEY) as Array<keyof ConnectImporters>) {
      const source = String(DEFAULT_IMPORTERS[key]);
      expect(source).toContain(`import('${SPECIFIER_BY_KEY[key]}')`);
    }
  });
});
