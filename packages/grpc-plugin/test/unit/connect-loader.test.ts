/**
 * Unit tests for the Connect runtime loader: the pure `adaptConnectModule`
 * adapter and the per-specifier failure branches of `loadConnectModule`, driven
 * through the injected importer so no network is required.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  adaptConnectModule,
  type ConnectModuleLike,
  defaultImporter,
  loadConnectModule,
  type ModuleImporter,
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
  const SPECIFIERS = [
    'npm:@connectrpc/connect@^2.1.2',
    'npm:@connectrpc/connect@^2.1.2/protocol',
    'npm:@bufbuild/protobuf@^2.7.0',
    'npm:@bufbuild/protobuf@^2.7.0/wkt',
  ];

  /** An importer that resolves every specifier except the named one. */
  function importerFailing(failing: string): ModuleImporter {
    const { modules } = createFakeModules();
    const bySpecifier: Record<string, unknown> = {
      'npm:@connectrpc/connect@^2.1.2': modules.connect,
      'npm:@connectrpc/connect@^2.1.2/protocol': modules.protocol,
      'npm:@bufbuild/protobuf@^2.7.0': modules.protobuf,
      'npm:@bufbuild/protobuf@^2.7.0/wkt': modules.wkt,
    };
    return (specifier) =>
      specifier === failing
        ? Promise.reject(new Error(`Module not found: ${specifier}`))
        : Promise.resolve(bySpecifier[specifier]);
  }

  it('assembles a runtime when all four specifiers resolve', async () => {
    const runtime = await loadConnectModule(importerFailing('none'));
    expect(typeof runtime.createConnectRouter).toBe('function');
    expect(typeof runtime.createFetchHandler).toBe('function');
    expect(typeof runtime.reviveDescriptorSet).toBe('function');
    expect(typeof runtime.getService).toBe('function');
    expect(typeof runtime.serializeFileDescriptor).toBe('function');
  });

  it('requests exactly the four documented specifiers', async () => {
    const requested: string[] = [];
    await loadConnectModule((specifier) => {
      requested.push(specifier);
      return importerFailing('none')(specifier);
    });
    expect(requested).toEqual(SPECIFIERS);
  });

  for (const specifier of SPECIFIERS) {
    it(`throws GrpcRuntimeLoadError naming '${specifier}' when it cannot be imported`, async () => {
      let thrown: unknown;
      try {
        await loadConnectModule(importerFailing(specifier));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(GrpcRuntimeLoadError);
      const error = thrown as GrpcRuntimeLoadError;
      expect(error.specifier).toBe(specifier);
      expect(error.message).toContain(specifier);
      // The message must carry a command the operator can actually run.
      expect(error.message).toContain('deno add npm:');
      expect(error.cause).toBeInstanceOf(Error);
    });
  }

  it('exposes a real dynamic import as the default importer, not a global hook', () => {
    // A `globalThis.__x` shim would throw in production even with the package
    // installed, because nothing would ever populate it.
    expect(typeof defaultImporter).toBe('function');
    expect(String(defaultImporter)).toContain('import(');
  });
});
