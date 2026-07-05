import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { buildNodeHost, createNodeRuntimeServices } from '../../src/adapters/node/node-runtime.ts';
import type {
  NodeFsOperations,
  NodeHost,
  NodeModules,
} from '../../src/adapters/node/node-runtime.ts';

// ---------------------------------------------------------------------------
// Fake NodeModules — in-memory fs stub with a Stats-like return from stat()
// ---------------------------------------------------------------------------

function createFakeNodeModules(
  overrides?: Partial<NodeModules>,
): NodeModules {
  const files = new Map<string, Uint8Array>();

  const fakeFs = {
    readFile: (path: string) => {
      const data = files.get(path);
      if (data === undefined) {
        return Promise.reject(new Error(`ENOENT: ${path}`));
      }
      return Promise.resolve(data);
    },
    writeFile: (path: string, data: Uint8Array) => {
      files.set(path, data);
      return Promise.resolve();
    },
    stat: (path: string) => {
      if (files.has(path)) {
        return Promise.resolve({
          isFile: () => true,
          isDirectory: () => false,
          size: files.get(path)!.length,
          mtime: new Date('2025-01-01T00:00:00Z'),
        } as never);
      }
      return Promise.resolve({
        isFile: () => false,
        isDirectory: () => true,
        size: 0,
        mtime: new Date('2025-01-01T00:00:00Z'),
      } as never);
    },
    readdir: (path: string) => {
      const entries: string[] = [];
      for (const key of files.keys()) {
        if (key.startsWith(path + '/')) {
          entries.push(key.split('/').pop()!);
        }
      }
      return Promise.resolve(entries);
    },
    mkdir: (_path: string) => Promise.resolve(),
    rm: (path: string) => {
      files.delete(path);
      return Promise.resolve();
    },
  };

  const fakeProc = {
    version: 'v20.10.0',
    env: { NODE_ENV: 'test' } as Record<string, string | undefined>,
    exit: (code?: number) => {
      throw new Error(`exit(${code ?? 0})`);
    },
  };

  const fakeHostname = () => 'fake-hostname';

  return {
    fs: fakeFs as NodeFsOperations,
    proc: fakeProc as NodeModules['proc'],
    hostname: fakeHostname,
    ...overrides,
  };
}

describe('buildNodeHost', () => {
  it('sets nodeVersion from proc.version', () => {
    const mods = createFakeNodeModules();
    const host = buildNodeHost(mods);
    expect(host.nodeVersion).toBe('v20.10.0');
  });

  it('sets hostname by calling mods.hostname()', () => {
    const mods = createFakeNodeModules();
    const host = buildNodeHost(mods);
    expect(host.hostname).toBe('fake-hostname');
  });

  it('sets env from proc.env', () => {
    const mods = createFakeNodeModules();
    const host = buildNodeHost(mods);
    expect(host.env.NODE_ENV).toBe('test');
  });

  it('exit() calls proc.exit()', () => {
    const mods = createFakeNodeModules();
    const host = buildNodeHost(mods);
    expect(() => host.exit(42)).toThrow('exit(42)');
  });

  it('exit() with no code calls proc.exit()', () => {
    const mods = createFakeNodeModules();
    const host = buildNodeHost(mods);
    expect(() => host.exit()).toThrow('exit(0)');
  });

  it('readFile delegates to fs.readFile', async () => {
    const mods = createFakeNodeModules();
    const host = buildNodeHost(mods);
    await host.writeFile('/readFile-test.txt', new Uint8Array([10, 20, 30]));
    const data = await host.readFile('/readFile-test.txt');
    expect(Array.from(data)).toEqual([10, 20, 30]);
  });

  it('writeFile delegates to fs.writeFile', async () => {
    const mods = createFakeNodeModules();
    const host = buildNodeHost(mods);
    await host.writeFile('/writeFile-test.txt', new Uint8Array([1, 2, 3]));
    const read = await host.readFile('/writeFile-test.txt');
    expect(Array.from(read)).toEqual([1, 2, 3]);
  });

  it('stat maps to NodeFsInfo with isFile true', async () => {
    const mods = createFakeNodeModules();
    const host = buildNodeHost(mods);
    await host.writeFile('/stat-file.txt', new Uint8Array([100]));
    const info = await host.stat('/stat-file.txt');
    expect(info.isFile).toBe(true);
    expect(info.isDirectory).toBe(false);
    expect(info.size).toBe(1);
    expect(info.mtime).toBeInstanceOf(Date);
  });

  it('stat maps to NodeFsInfo with isDirectory true', async () => {
    const mods = createFakeNodeModules();
    const host = buildNodeHost(mods);
    // A path that has no file entry — the fake returns directory
    const info = await host.stat('/nonexistent');
    expect(info.isFile).toBe(false);
    expect(info.isDirectory).toBe(true);
  });

  it('readdir delegates to fs.readdir', async () => {
    const mods = createFakeNodeModules();
    const host = buildNodeHost(mods);
    await host.writeFile('/dir/a.txt', new Uint8Array([1]));
    await host.writeFile('/dir/b.txt', new Uint8Array([2]));
    const entries = await host.readdir('/dir');
    expect(entries).toContain('a.txt');
    expect(entries).toContain('b.txt');
  });

  it('mkdir delegates to fs.mkdir', async () => {
    const mods = createFakeNodeModules();
    const host = buildNodeHost(mods);
    // Should not throw
    await host.mkdir('/new-dir', { recursive: true });
  });

  it('rm delegates to fs.rm', async () => {
    const mods = createFakeNodeModules();
    const host = buildNodeHost(mods);
    await host.writeFile('/rm-test.txt', new Uint8Array([1]));
    await host.rm('/rm-test.txt');
    // After rm, readFile should fail (file deleted from fake in-memory map)
    await expect(host.readFile('/rm-test.txt')).rejects.toThrow('ENOENT');
  });
});

function createFakeNodeHost(overrides: Partial<NodeHost> = {}): NodeHost {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(['/tmp']);

  return {
    nodeVersion: 'v18.19.0',
    hostname: 'node-host',
    env: { NODE_ENV: 'test', PATH: '/usr/local/bin' },
    exit: (code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    },
    readFile: (path: string) => {
      const data = files.get(path);
      if (data === undefined) {
        return Promise.reject(new Error(`ENOENT: ${path}`));
      }
      return Promise.resolve(data);
    },
    writeFile: (path: string, data: Uint8Array) => {
      files.set(path, data);
      return Promise.resolve();
    },
    stat: (path: string) => {
      if (files.has(path)) {
        return Promise.resolve({
          isFile: true,
          isDirectory: false,
          size: files.get(path)!.length,
          mtime: new Date('2025-01-01T00:00:00Z'),
        });
      }
      if (dirs.has(path)) {
        return Promise.resolve({
          isFile: false,
          isDirectory: true,
          size: 0,
          mtime: new Date('2025-01-01T00:00:00Z'),
        });
      }
      return Promise.reject(new Error(`ENOENT: ${path}`));
    },
    readdir: (path: string) => {
      if (!dirs.has(path)) {
        return Promise.resolve([] as readonly string[]);
      }
      const entries: string[] = [];
      for (const key of files.keys()) {
        if (key.startsWith(path + '/')) {
          entries.push(key.split('/').pop()!);
        }
      }
      return Promise.resolve(entries as readonly string[]);
    },
    mkdir: (path: string) => {
      dirs.add(path);
      return Promise.resolve();
    },
    rm: (path: string) => {
      files.delete(path);
      dirs.delete(path);
      return Promise.resolve();
    },
    ...overrides,
  };
}

describe('createNodeRuntimeServices', () => {
  it('returns platform "node"', () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    expect(services.platform()).toBe('node');
  });

  it('returns the Node version', () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    expect(services.version()).toBe('v18.19.0');
  });

  it('returns the hostname', () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    expect(services.hostname()).toBe('node-host');
  });

  it('returns environment variables', () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    expect(services.env.NODE_ENV).toBe('test');
    expect(services.env.PATH).toBe('/usr/local/bin');
  });

  it('exit throws via the host', () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    expect(() => services.exit(2)).toThrow('process.exit(2)');
  });

  it('exit with no code defaults to 0', () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    expect(() => services.exit()).toThrow('process.exit(0)');
  });

  it('fs.readFile reads a written file', async () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    const fs = services.fs!;
    await fs.writeFile('/test.txt', new Uint8Array([1, 2, 3]));
    const data = await fs.readFile('/test.txt');
    expect(Array.from(data)).toEqual([1, 2, 3]);
  });

  it('fs.readFile rejects for missing file', async () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    const fs = services.fs!;
    await expect(fs.readFile('/missing.txt')).rejects.toThrow('ENOENT');
  });

  it('fs.stat returns file info', async () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    const fs = services.fs!;
    await fs.writeFile('/stat.txt', new Uint8Array([10, 20]));
    const stat = await fs.stat('/stat.txt');
    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
    expect(stat.size).toBe(2);
    expect(stat.mtime).toBeInstanceOf(Date);
  });

  it('fs.stat returns directory info', async () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    const fs = services.fs!;
    const stat = await fs.stat('/tmp');
    expect(stat.isDirectory).toBe(true);
    expect(stat.isFile).toBe(false);
  });

  it('fs.readdir lists entries', async () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    const fs = services.fs!;
    await fs.writeFile('/tmp/a.txt', new Uint8Array([1]));
    await fs.writeFile('/tmp/b.txt', new Uint8Array([2]));
    const entries = await fs.readdir('/tmp');
    expect(entries).toContain('a.txt');
    expect(entries).toContain('b.txt');
  });

  it('fs.mkdir creates a directory', async () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    const fs = services.fs!;
    await fs.mkdir('/newdir', { recursive: true });
    const stat = await fs.stat('/newdir');
    expect(stat.isDirectory).toBe(true);
  });

  it('fs.rm removes a file', async () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    const fs = services.fs!;
    await fs.writeFile('/rm.txt', new Uint8Array([1]));
    await fs.rm('/rm.txt');
    await expect(fs.readFile('/rm.txt')).rejects.toThrow();
  });

  it('fs.rm removes a directory recursively', async () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    const fs = services.fs!;
    await fs.mkdir('/rmdir', { recursive: true });
    await fs.rm('/rmdir', { recursive: true });
    await expect(fs.stat('/rmdir')).rejects.toThrow();
  });

  it('provides cross-runtime uuid', () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    expect(services.uuid()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('provides cross-runtime randomBytes', () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    expect(services.randomBytes(8).length).toBe(8);
  });

  it('provides cross-runtime subtle', () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    expect(services.subtle).toBeDefined();
  });

  it('provides cross-runtime now', () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    expect(services.now()).toBeGreaterThan(0);
  });

  it('provides cross-runtime hrtime', () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    expect(services.hrtime()).toBeGreaterThanOrEqual(0);
  });

  it('provides timers', () => {
    const services = createNodeRuntimeServices(createFakeNodeHost());
    expect(typeof services.setTimeout).toBe('function');
    expect(typeof services.clearTimeout).toBe('function');
    expect(typeof services.setInterval).toBe('function');
    expect(typeof services.clearInterval).toBe('function');
  });
});

describe('createNodeRuntimeServices with default host', () => {
  it('uses default host when called with no argument', () => {
    const services = createNodeRuntimeServices();
    expect(services.platform()).toBe('node');
    expect(services.version()).toMatch(/^v/);
    expect(typeof services.hostname()).toBe('string');
    expect(typeof services.env).toBe('object');
  });
});
