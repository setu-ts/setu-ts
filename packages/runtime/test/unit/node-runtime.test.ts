import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { buildNodeHost, createNodeRuntimeServices } from '../../src/adapters/node/node-runtime.ts';
import type { NodeHost, NodeHostLoaders } from '../../src/adapters/node/node-runtime.ts';

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

describe('buildNodeHost', () => {
  function createFakeLoaders(
    overrides: Partial<NodeHostLoaders> = {},
  ): NodeHostLoaders {
    const files = new Map<string, Uint8Array>();
    const dirs = new Set<string>(['/tmp']);

    const process = {
      version: 'v20.0.0',
      env: { NODE_ENV: 'production' },
      exit: (code?: number): never => {
        throw new Error(`process.exit(${code ?? 0})`);
      },
    };

    const os = {
      hostname: () => 'fake-node-host',
    };

    const fs = {
      readFile: (p: string) => {
        const data = files.get(p);
        if (data === undefined) return Promise.reject(new Error(`ENOENT: ${p}`));
        return Promise.resolve(data);
      },
      writeFile: (p: string, d: Uint8Array) => {
        files.set(p, d);
        return Promise.resolve();
      },
      stat: (p: string) => {
        if (files.has(p)) {
          return Promise.resolve({
            isFile: () => true,
            isDirectory: () => false,
            size: files.get(p)!.length,
            mtime: new Date('2025-01-01'),
          });
        }
        if (dirs.has(p)) {
          return Promise.resolve({
            isFile: () => false,
            isDirectory: () => true,
            size: 0,
            mtime: new Date('2025-01-01'),
          });
        }
        return Promise.reject(new Error(`ENOENT: ${p}`));
      },
      readdir: (p: string) => {
        if (!dirs.has(p)) return Promise.resolve([]);
        const entries: string[] = [];
        for (const key of files.keys()) {
          if (key.startsWith(p + '/')) {
            entries.push(key.split('/').pop()!);
          }
        }
        return Promise.resolve(entries);
      },
      mkdir: (p: string) => {
        dirs.add(p);
        return Promise.resolve();
      },
      rm: (p: string) => {
        files.delete(p);
        dirs.delete(p);
        return Promise.resolve();
      },
    };

    return {
      require: <T>(specifier: string): T => {
        if (specifier === 'node:process') return process as unknown as T;
        if (specifier === 'node:os') return os as unknown as T;
        throw new Error(`Unknown require: ${specifier}`);
      },
      import: <T>(specifier: string): Promise<T> => {
        if (specifier === 'node:fs/promises') return Promise.resolve(fs as unknown as T);
        return Promise.reject(new Error(`Unknown import: ${specifier}`));
      },
      ...overrides,
    };
  }

  it('returns nodeVersion from the process module', () => {
    const host = buildNodeHost(createFakeLoaders());
    expect(host.nodeVersion).toBe('v20.0.0');
  });

  it('returns hostname from the os module', () => {
    const host = buildNodeHost(createFakeLoaders());
    expect(host.hostname).toBe('fake-node-host');
  });

  it('returns env from the process module', () => {
    const host = buildNodeHost(createFakeLoaders());
    expect(host.env.NODE_ENV).toBe('production');
  });

  it('exit calls process.exit', () => {
    const host = buildNodeHost(createFakeLoaders());
    expect(() => host.exit(42)).toThrow('process.exit(42)');
  });

  it('exit with no code defaults to 0', () => {
    const host = buildNodeHost(createFakeLoaders());
    expect(() => host.exit()).toThrow('process.exit(0)');
  });

  it('readFile reads via the fs module', async () => {
    const host = buildNodeHost(createFakeLoaders());
    await host.writeFile('/test.txt', new Uint8Array([1, 2, 3]));
    const data = await host.readFile('/test.txt');
    expect(Array.from(data)).toEqual([1, 2, 3]);
  });

  it('readFile rejects for missing file', async () => {
    const host = buildNodeHost(createFakeLoaders());
    await expect(host.readFile('/missing.txt')).rejects.toThrow('ENOENT');
  });

  it('writeFile writes via the fs module', async () => {
    const host = buildNodeHost(createFakeLoaders());
    await host.writeFile('/write.txt', new Uint8Array([10, 20]));
    const data = await host.readFile('/write.txt');
    expect(Array.from(data)).toEqual([10, 20]);
  });

  it('stat returns file info via the fs module', async () => {
    const host = buildNodeHost(createFakeLoaders());
    await host.writeFile('/stat.txt', new Uint8Array([1, 2, 3, 4]));
    const stat = await host.stat('/stat.txt');
    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
    expect(stat.size).toBe(4);
    expect(stat.mtime).toBeInstanceOf(Date);
  });

  it('stat returns directory info via the fs module', async () => {
    const host = buildNodeHost(createFakeLoaders());
    const stat = await host.stat('/tmp');
    expect(stat.isDirectory).toBe(true);
    expect(stat.isFile).toBe(false);
  });

  it('stat rejects for missing path', async () => {
    const host = buildNodeHost(createFakeLoaders());
    await expect(host.stat('/nonexistent')).rejects.toThrow('ENOENT');
  });

  it('readdir lists entries via the fs module', async () => {
    const host = buildNodeHost(createFakeLoaders());
    await host.writeFile('/tmp/a.txt', new Uint8Array([1]));
    await host.writeFile('/tmp/b.txt', new Uint8Array([2]));
    const entries = await host.readdir('/tmp');
    expect(entries).toContain('a.txt');
    expect(entries).toContain('b.txt');
  });

  it('mkdir creates a directory via the fs module', async () => {
    const host = buildNodeHost(createFakeLoaders());
    await host.mkdir('/newdir', { recursive: true });
    const stat = await host.stat('/newdir');
    expect(stat.isDirectory).toBe(true);
  });

  it('rm removes a file via the fs module', async () => {
    const host = buildNodeHost(createFakeLoaders());
    await host.writeFile('/rm.txt', new Uint8Array([1]));
    await host.rm('/rm.txt');
    await expect(host.readFile('/rm.txt')).rejects.toThrow();
  });

  it('rm removes a directory recursively via the fs module', async () => {
    const host = buildNodeHost(createFakeLoaders());
    await host.mkdir('/rmdir', { recursive: true });
    await host.rm('/rmdir', { recursive: true });
    await expect(host.stat('/rmdir')).rejects.toThrow();
  });

  it('caches the process module across calls', () => {
    let requireCount = 0;
    const loaders = createFakeLoaders({
      require: <T>(spec: string): T => {
        requireCount++;
        if (spec === 'node:process') {
          return { version: 'v1', env: {}, exit: () => {} } as unknown as T;
        }
        return { hostname: () => 'h' } as unknown as T;
      },
    });
    const host = buildNodeHost(loaders);
    void host.nodeVersion;
    void host.env;
    expect(requireCount).toBe(1);
  });

  it('caches the hostname across calls', () => {
    let osCount = 0;
    const loaders = createFakeLoaders({
      require: <T>(spec: string): T => {
        if (spec === 'node:os') {
          osCount++;
          return { hostname: () => 'cached-host' } as unknown as T;
        }
        return { version: 'v1', env: {}, exit: () => {} } as unknown as T;
      },
    });
    const host = buildNodeHost(loaders);
    void host.hostname;
    void host.hostname;
    expect(osCount).toBe(1);
  });
});
