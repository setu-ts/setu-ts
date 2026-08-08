import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDenoRuntimeServices } from '../../src/adapters/deno/deno-runtime.ts';
import type { DenoHost } from '../../src/adapters/deno/deno-runtime.ts';

/** A minimal fake FsFile that tracks close() calls and supports seek/read. */
function makeFakeFsFile(
  data: Uint8Array,
  opts?: { onReadError?: Error; onClose?: () => void },
): Deno.FsFile {
  let position = 0;
  return {
    seek: (offset: number, mode: Deno.SeekMode): Promise<number> => {
      if (mode === Deno.SeekMode.Start) position = offset;
      else if (mode === Deno.SeekMode.End) position = data.length + offset;
      else position += offset;
      return Promise.resolve(position);
    },
    read: (buffer: Uint8Array): Promise<number | null> => {
      if (opts?.onReadError) throw opts.onReadError;
      if (position >= data.length) return Promise.resolve(null);
      const remaining = data.length - position;
      const toRead = Math.min(buffer.length, remaining);
      buffer.set(data.subarray(position, position + toRead));
      position += toRead;
      return Promise.resolve(toRead);
    },
    write: (_buffer: Uint8Array): Promise<number> => {
      return Promise.reject(new Error('write not supported'));
    },
    close: (): Promise<void> => {
      opts?.onClose?.();
      return Promise.resolve();
    },
    isTerminal: () => false,
    get readUrl() {
      return undefined;
    },
  } as unknown as Deno.FsFile;
}

function makeHost(
  data: Uint8Array,
  opts?: { onReadError?: Error; onClose?: () => void },
): DenoHost {
  return {
    version: { deno: '2.7.5' },
    hostname: () => 'deno-host',
    env: { toObject: () => ({}) },
    exit: () => {
      throw new Error('exit');
    },
    readFile: () => Promise.resolve(data),
    realPath: (path: string) => Promise.resolve(path),
    writeFile: () => Promise.resolve(),
    stat: () =>
      Promise.resolve({
        isFile: true,
        isDirectory: false,
        size: data.length,
        mtime: new Date('2025-01-01T00:00:00Z'),
      }),
    readDir: async function* () {},
    mkdir: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    resolveDns: () => Promise.resolve([]),
    open: () => Promise.resolve(makeFakeFsFile(data, opts)),
  };
}

describe('Deno readStream — normal completion closes the host handle exactly once', () => {
  it('closes the file after the stream is fully consumed', async () => {
    let closeCount = 0;
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const host = makeHost(data, {
      onClose: () => {
        closeCount++;
      },
    });
    const services = createDenoRuntimeServices(host);
    const fs = services.fs!;

    expect(fs.readStream).toBeDefined();
    const stream = await fs.readStream!('/any');
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(new Uint8Array(chunks.flatMap((c) => Array.from(c)))).toEqual(data);
    expect(closeCount).toBe(1);
  });

  it('closes the file once when the consumer cancels early', async () => {
    let closeCount = 0;
    const data = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
    const host = makeHost(data, {
      onClose: () => {
        closeCount++;
      },
    });
    const services = createDenoRuntimeServices(host);
    const fs = services.fs!;

    const stream = await fs.readStream!('/any');
    const reader = stream.getReader();
    // The first chunk contains all 100 bytes (chunkSize is 64KB)
    const { value: firstChunk } = await reader.read();
    expect(firstChunk!.length).toBe(100);
    // Cancel the stream without consuming the rest
    await reader.cancel();
    // The cancel path should have closed the file exactly once
    expect(closeCount).toBe(1);
  });
});

describe('Deno readStream — range byte limits', () => {
  it('serves the exact range when start and end are provided', async () => {
    const data = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
    const host = makeHost(data);
    const services = createDenoRuntimeServices(host);
    const fs = services.fs!;

    const stream = await fs.readStream!('/any', { start: 10, end: 19 });
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const result = new Uint8Array(chunks.flatMap((c) => Array.from(c)));
    expect(result).toEqual(data.subarray(10, 20));
    expect(result.length).toBe(10);
  });

  it('serves an open-ended range (bytes=50-) correctly', async () => {
    const data = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
    const host = makeHost(data);
    const services = createDenoRuntimeServices(host);
    const fs = services.fs!;

    const stream = await fs.readStream!('/any', { start: 50 });
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const result = new Uint8Array(chunks.flatMap((c) => Array.from(c)));
    expect(result).toEqual(data.subarray(50));
    expect(result.length).toBe(50);
  });

  it('serves the whole file when no range options are provided', async () => {
    const data = new Uint8Array(Array.from({ length: 50 }, (_, i) => i));
    const host = makeHost(data);
    const services = createDenoRuntimeServices(host);
    const fs = services.fs!;

    const stream = await fs.readStream!('/any');
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const result = new Uint8Array(chunks.flatMap((c) => Array.from(c)));
    expect(result).toEqual(data);
    expect(result.length).toBe(50);
  });
});

describe('Deno readStream — source error closes the handle', () => {
  it('closes the file when the underlying read throws', async () => {
    let closeCount = 0;
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const ioError = new Error('IO error');
    const host = makeHost(data, {
      onReadError: ioError,
      onClose: () => {
        closeCount++;
      },
    });
    const services = createDenoRuntimeServices(host);
    const fs = services.fs!;

    const stream = await fs.readStream!('/any');
    const reader = stream.getReader();
    await expect(reader.read()).rejects.toThrow('IO error');
    expect(closeCount).toBe(1);
  });
});
