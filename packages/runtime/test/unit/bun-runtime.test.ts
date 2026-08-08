import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { buildBunHost, createBunRuntimeServices } from '../../src/adapters/bun/bun-runtime.ts';
import type { BunHost, BunModules } from '../../src/adapters/bun/bun-runtime.ts';

function createFakeBunHost(overrides: Partial<BunHost> = {}): BunHost {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(['/tmp']);

  return {
    version: '1.1.0',
    hostname: 'bun-host',
    env: { BUN_ENV: 'test' },
    exit: (code?: number) => {
      throw new Error(`Bun.exit(${code ?? 0})`);
    },
    readFile: (path: string) => files.get(path) ?? null,
    realPath: (path: string) => (files.has(path) || dirs.has(path) ? path : null),
    writeFile: (path: string, data: Uint8Array) => {
      files.set(path, data);
    },
    stat: (path: string) => {
      if (files.has(path)) {
        return {
          isFile: true,
          isDirectory: false,
          size: files.get(path)!.length,
          mtime: new Date('2025-01-01T00:00:00Z'),
        };
      }
      if (dirs.has(path)) {
        return {
          isFile: false,
          isDirectory: true,
          size: 0,
          mtime: new Date('2025-01-01T00:00:00Z'),
        };
      }
      return null;
    },
    readdir: (path: string) => {
      if (!dirs.has(path)) {
        return null;
      }
      const entries: string[] = [];
      for (const key of files.keys()) {
        if (key.startsWith(path + '/')) {
          entries.push(key.split('/').pop()!);
        }
      }
      return entries;
    },
    mkdir: (path: string) => {
      dirs.add(path);
      return true;
    },
    rm: (path: string) => {
      files.delete(path);
      dirs.delete(path);
      return true;
    },
    ...overrides,
  };
}

describe('createBunRuntimeServices', () => {
  it('returns platform "bun"', () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    expect(services.platform()).toBe('bun');
  });

  it('returns the Bun version', () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    expect(services.version()).toBe('1.1.0');
  });

  it('returns the hostname', () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    expect(services.hostname()).toBe('bun-host');
  });

  it('returns environment variables', () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    expect(services.env.BUN_ENV).toBe('test');
  });

  it('exit throws via the host', () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    expect(() => services.exit(3)).toThrow('Bun.exit(3)');
  });

  it('exit with no code defaults to 0', () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    expect(() => services.exit()).toThrow('Bun.exit(0)');
  });

  it('fs.readFile reads a written file', async () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    const fs = services.fs!;
    await fs.writeFile('/test.txt', new Uint8Array([1, 2, 3]));
    const data = await fs.readFile('/test.txt');
    expect(Array.from(data)).toEqual([1, 2, 3]);
  });

  it('fs.readFile rejects for missing file', async () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    const fs = services.fs!;
    await expect(fs.readFile('/missing.txt')).rejects.toThrow('ENOENT');
  });

  it('fs.realPath resolves an existing path and rejects a missing one', async () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    const fs = services.fs!;
    await fs.writeFile('/real.txt', new Uint8Array([1]));
    expect(await fs.realPath!('/real.txt')).toBe('/real.txt');
    await expect(fs.realPath!('/missing.txt')).rejects.toThrow('ENOENT');
  });

  it('fs.stat returns file info', async () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    const fs = services.fs!;
    await fs.writeFile('/stat.txt', new Uint8Array([10, 20]));
    const stat = await fs.stat('/stat.txt');
    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
    expect(stat.size).toBe(2);
    expect(stat.mtime).toBeInstanceOf(Date);
  });

  it('fs.stat returns directory info', async () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    const fs = services.fs!;
    const stat = await fs.stat('/tmp');
    expect(stat.isDirectory).toBe(true);
    expect(stat.isFile).toBe(false);
  });

  it('fs.stat rejects for missing path', async () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    const fs = services.fs!;
    await expect(fs.stat('/nonexistent')).rejects.toThrow('ENOENT');
  });

  it('fs.readdir lists entries', async () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    const fs = services.fs!;
    await fs.writeFile('/tmp/a.txt', new Uint8Array([1]));
    await fs.writeFile('/tmp/b.txt', new Uint8Array([2]));
    const entries = await fs.readdir('/tmp');
    expect(entries).toContain('a.txt');
    expect(entries).toContain('b.txt');
  });

  it('fs.readdir rejects for missing path', async () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    const fs = services.fs!;
    await expect(fs.readdir('/nonexistent')).rejects.toThrow('ENOENT');
  });

  it('fs.mkdir creates a directory', async () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    const fs = services.fs!;
    await fs.mkdir('/newdir', { recursive: true });
    const stat = await fs.stat('/newdir');
    expect(stat.isDirectory).toBe(true);
  });

  it('fs.mkdir rejects on failure', async () => {
    const host = createFakeBunHost({
      mkdir: () => false,
    });
    const services = createBunRuntimeServices(host);
    const fs = services.fs!;
    await expect(fs.mkdir('/fail')).rejects.toThrow('mkdir failed');
  });

  it('fs.rm removes a file', async () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    const fs = services.fs!;
    await fs.writeFile('/rm.txt', new Uint8Array([1]));
    await fs.rm('/rm.txt');
    await expect(fs.readFile('/rm.txt')).rejects.toThrow();
  });

  it('fs.rm rejects on failure', async () => {
    const host = createFakeBunHost({
      rm: () => false,
    });
    const services = createBunRuntimeServices(host);
    const fs = services.fs!;
    await expect(fs.rm('/fail')).rejects.toThrow('rm failed');
  });

  it('provides cross-runtime uuid', () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    expect(services.uuid()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('provides cross-runtime randomBytes', () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    expect(services.randomBytes(8).length).toBe(8);
  });

  it('provides cross-runtime subtle', () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    expect(services.subtle).toBeDefined();
  });

  it('provides cross-runtime now', () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    expect(services.now()).toBeGreaterThan(0);
  });

  it('provides cross-runtime hrtime', () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    expect(services.hrtime()).toBeGreaterThanOrEqual(0);
  });

  it('provides timers', () => {
    const services = createBunRuntimeServices(createFakeBunHost());
    expect(typeof services.setTimeout).toBe('function');
    expect(typeof services.clearTimeout).toBe('function');
    expect(typeof services.setInterval).toBe('function');
    expect(typeof services.clearInterval).toBe('function');
  });

  it('writeFile rejects (never throws synchronously) when the host write fails', async () => {
    const services = createBunRuntimeServices(
      createFakeBunHost({
        writeFile: () => {
          throw new Error('EACCES: permission denied');
        },
      }),
    );
    // A synchronous throw here would bypass a caller's `.catch` / `try { await }`.
    await expect(services.fs!.writeFile('/tmp/x', new Uint8Array([1]))).rejects.toThrow(
      'EACCES',
    );
  });
});

// The default host used to be `globalThis.Bun as BunHost`, whose file-system,
// hostname, and exit members do not exist on the real Bun global — every test
// above injects a fake, so nothing ever exercised it. buildBunHost() is backed
// by `node:` built-ins, which Bun implements and which run here on Deno too.
describe('buildBunHost — the default host', () => {
  it('reads, stats, lists, and resolves through the real node: built-ins', () => {
    const host = buildBunHost();
    // Read-only: the suite runs without --allow-write, so exercise the real
    // built-ins against files already in the repo. The write paths are covered
    // through injected modules below, which also assert argument translation.
    const bytes = host.readFile('packages/runtime/deno.json');
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toContain('@setu-ts/runtime');

    const info = host.stat('packages/runtime/deno.json')!;
    expect(info.isFile).toBe(true);
    expect(info.isDirectory).toBe(false);
    expect(info.size).toBeGreaterThan(0);
    expect(info.mtime instanceof Date).toBe(true);

    expect(host.readdir('packages/runtime/src')).toContain('index.ts');
    expect(host.realPath('packages/runtime/deno.json')).toContain('runtime');

    expect(typeof host.hostname).toBe('string');
    expect(typeof host.version).toBe('string');
    expect(host.env).toBeDefined();
  });

  it('translates write, mkdir and rm through to the underlying built-ins', () => {
    const calls: string[] = [];
    const host = buildBunHost({
      fs: {
        readFileSync: () => new Uint8Array(),
        realpathSync: (p: string) => p,
        writeFileSync: (p: string, data: Uint8Array) => {
          calls.push(`write:${p}:${data.length}`);
        },
        statSync: () => ({
          isFile: () => true,
          isDirectory: () => false,
          size: 0,
          mtime: new Date(0),
        }),
        readdirSync: () => [],
        mkdirSync: (p: string, options?: { recursive?: boolean }) => {
          calls.push(`mkdir:${p}:${options?.recursive === true}`);
          return undefined;
        },
        rmSync: (p: string, options?: { recursive?: boolean }) => {
          calls.push(`rm:${p}:${options?.recursive === true}`);
        },
      },
      proc: {
        version: 'v22.0.0',
        versions: { bun: '1.1.0' },
        env: {},
        exit: () => {
          throw new Error('exit');
        },
      },
      hostname: () => 'fake-host',
      bunGlobal: undefined,
    });

    host.writeFile('/tmp/a.bin', new Uint8Array([1, 2, 3]));
    expect(host.mkdir('/tmp/deep', { recursive: true })).toBe(true);
    expect(host.rm('/tmp/deep', { recursive: true })).toBe(true);
    expect(calls).toEqual(['write:/tmp/a.bin:3', 'mkdir:/tmp/deep:true', 'rm:/tmp/deep:true']);
  });

  it('reports null / false instead of throwing for missing paths', () => {
    const host = buildBunHost();
    expect(host.readFile('/definitely/not/here')).toBeNull();
    expect(host.realPath('/definitely/not/here')).toBeNull();
    expect(host.stat('/definitely/not/here')).toBeNull();
    expect(host.readdir('/definitely/not/here')).toBeNull();
    expect(host.rm('/definitely/not/here')).toBe(false);
  });

  it('mkdir reports false when the underlying call fails', () => {
    const mods: BunModules = {
      fs: {
        readFileSync: () => new Uint8Array(),
        realpathSync: (p: string) => p,
        writeFileSync: () => {},
        statSync: () => ({
          isFile: () => true,
          isDirectory: () => false,
          size: 0,
          mtime: new Date(0),
        }),
        readdirSync: () => [],
        mkdirSync: () => {
          throw new Error('EEXIST');
        },
        rmSync: () => {},
      },
      proc: {
        version: 'v22.0.0',
        versions: { bun: '1.1.0' },
        env: {},
        exit: () => {
          throw new Error('exit');
        },
      },
      hostname: () => 'fake-host',
      bunGlobal: undefined,
    };
    const host = buildBunHost(mods);
    expect(host.mkdir('/anywhere')).toBe(false);
    // Version comes from process.versions.bun when the Bun global is absent.
    expect(host.version).toBe('1.1.0');
    expect(host.hostname).toBe('fake-host');
    expect(() => host.exit(1)).toThrow('exit');
  });

  it('prefers the Bun global version when running on Bun', () => {
    const host = buildBunHost({
      fs: {
        readFileSync: () => new Uint8Array(),
        realpathSync: (p: string) => p,
        writeFileSync: () => {},
        statSync: () => ({
          isFile: () => true,
          isDirectory: () => false,
          size: 0,
          mtime: new Date(0),
        }),
        readdirSync: () => [],
        mkdirSync: () => undefined,
        rmSync: () => {},
      },
      proc: {
        version: 'v22.0.0',
        versions: { bun: '1.1.0' },
        env: {},
        exit: () => {
          throw new Error('exit');
        },
      },
      hostname: () => 'fake-host',
      // On Bun this is `globalThis.Bun`; its version wins over process.versions.
      bunGlobal: { version: '1.2.3' },
    });
    expect(host.version).toBe('1.2.3');
  });

  it('falls back to process.version when neither the Bun global nor versions.bun exists', () => {
    const host = buildBunHost({
      fs: {
        readFileSync: () => new Uint8Array(),
        realpathSync: (p: string) => p,
        writeFileSync: () => {},
        statSync: () => ({
          isFile: () => true,
          isDirectory: () => false,
          size: 0,
          mtime: new Date(0),
        }),
        readdirSync: () => [],
        mkdirSync: () => undefined,
        rmSync: () => {},
      },
      proc: {
        version: 'v22.0.0',
        versions: {},
        env: {},
        exit: () => {
          throw new Error('exit');
        },
      },
      hostname: () => 'fake-host',
      bunGlobal: undefined,
    });
    expect(host.version).toBe('v22.0.0');
  });
});

describe('Bun runtime readStream branches', () => {
  it('throws a named error when the host exposes no createReadStream', async () => {
    // Absent, not `undefined` — `exactOptionalPropertyTypes` distinguishes them.
    const host: BunHost = { ...createFakeBunHost() };
    delete (host as { createReadStream?: unknown }).createReadStream;
    const fs = createBunRuntimeServices(host).fs;

    await expect(fs!.readStream!('/tmp/whatever')).rejects.toThrow(
      'readStream not supported on this Bun version',
    );
  });

  it('throws when the host cannot open the path', async () => {
    const fs = createBunRuntimeServices(
      createFakeBunHost({ createReadStream: () => null }),
    ).fs;

    await expect(fs!.readStream!('/tmp/missing')).rejects.toThrow(
      'Failed to create read stream',
    );
  });

  it('converts an injected Node Readable into a web stream', async () => {
    const { Readable } = await import('node:stream');
    const fs = createBunRuntimeServices(
      createFakeBunHost({
        createReadStream: () => Readable.from([new Uint8Array([4, 5])]) as never,
      }),
    ).fs;

    const stream = await fs!.readStream!('/tmp/injected');
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(Array.from(chunks[0]!)).toEqual([4, 5]);
  });
});

describe('buildBunHost createReadStream wiring', () => {
  it('returns null when the injected fs module exposes no createReadStream', () => {
    const mods: BunModules = {
      fs: {
        readFileSync: () => new Uint8Array(),
        realpathSync: (p: string) => p,
        writeFileSync: () => {},
        statSync: () => ({
          isFile: () => true,
          isDirectory: () => false,
          size: 0,
          mtime: new Date(),
        }),
        readdirSync: () => [],
        mkdirSync: () => undefined,
        rmSync: () => {},
      },
      proc: { version: 'v1', versions: {}, env: {}, exit: (() => {}) as never },
      hostname: () => 'h',
      bunGlobal: { version: '1.1.0' },
    };

    // The `?.` short-circuit: no underlying function, so the host member must
    // report null rather than throwing a TypeError.
    expect(buildBunHost(mods).createReadStream!('/tmp/x')).toBe(null);
  });

  it('returns null when the underlying createReadStream throws', () => {
    const mods: BunModules = {
      fs: {
        readFileSync: () => new Uint8Array(),
        realpathSync: (p: string) => p,
        writeFileSync: () => {},
        statSync: () => ({
          isFile: () => true,
          isDirectory: () => false,
          size: 0,
          mtime: new Date(),
        }),
        readdirSync: () => [],
        mkdirSync: () => undefined,
        rmSync: () => {},
        createReadStream: () => {
          throw new Error('ENOENT');
        },
      },
      proc: { version: 'v1', versions: {}, env: {}, exit: (() => {}) as never },
      hostname: () => 'h',
      bunGlobal: { version: '1.1.0' },
    };

    expect(buildBunHost(mods).createReadStream!('/tmp/x')).toBe(null);
  });
});
