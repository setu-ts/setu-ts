import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IFileSystem, IWorkerHandle, IWorkerHost } from '../../src/runtime.ts';

describe('IFileSystem.readStream is optional', () => {
  it('should satisfy IFileSystem without readStream', () => {
    const fs: IFileSystem = {
      readFile: () => Promise.resolve(new Uint8Array()),
      writeFile: () => Promise.resolve(),
      stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 10 }),
      readdir: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
    };
    expect(fs).toBeDefined();
    expect(fs.readFile).toBeDefined();
    expect(fs.stat).toBeDefined();
    expect(fs.readStream).toBeUndefined();
  });

  it('should satisfy IFileSystem with readStream', () => {
    const fs: IFileSystem = {
      readFile: () => Promise.resolve(new Uint8Array()),
      writeFile: () => Promise.resolve(),
      stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 10 }),
      readdir: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
      readStream: () => Promise.resolve(new ReadableStream()),
    };
    expect(fs).toBeDefined();
    expect(fs.readStream).toBeDefined();
  });
});

describe('IWorkerHandle.onExit and IWorkerHost.reportsExit are optional', () => {
  it('should satisfy IWorkerHandle without onExit', () => {
    // Deno's web `Worker` reports nothing when a thread ends, so its host omits
    // the member entirely rather than registering a listener that can never
    // fire. If this ever stops compiling, that widening became REQUIRED and
    // every existing handle implementation broke.
    const handle: IWorkerHandle = {
      postMessage: () => {},
      onMessage: () => {},
      onError: () => {},
      terminate: () => Promise.resolve(),
    };
    expect('onExit' in handle).toBe(false);
  });

  it('should satisfy IWorkerHandle with onExit', () => {
    let received: number | null = -1;
    const handle: IWorkerHandle = {
      postMessage: () => {},
      onMessage: () => {},
      onError: () => {},
      onExit: (listener) => listener(3),
      terminate: () => Promise.resolve(),
    };
    handle.onExit?.((code) => received = code);
    expect(received).toBe(3);
  });

  it('should carry a null code, since a web close event may report none', () => {
    // `number | null`, not `number`: Node reports a numeric exit code while a
    // web `close` event may carry nothing at all.
    let received: number | null = 0;
    const handle: IWorkerHandle = {
      postMessage: () => {},
      onMessage: () => {},
      onError: () => {},
      onExit: (listener) => listener(null),
      terminate: () => Promise.resolve(),
    };
    handle.onExit?.((code) => received = code);
    expect(received).toBeNull();
  });

  it('should satisfy IWorkerHost with and without reportsExit', () => {
    const silent: IWorkerHost = {
      spawn: () => {
        throw new Error('not spawned in this test');
      },
      availableParallelism: () => 1,
    };
    const reporting: IWorkerHost = { ...silent, reportsExit: () => true };

    // `?? false` is how every consumer reads it: absence means "cannot report".
    expect(silent.reportsExit?.() ?? false).toBe(false);
    expect(reporting.reportsExit?.() ?? false).toBe(true);
  });
});
