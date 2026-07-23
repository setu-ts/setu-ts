import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createDenoRuntimeServices } from '../../src/adapters/deno/deno-runtime.ts';
import type { DenoHost } from '../../src/adapters/deno/deno-runtime.ts';

function createFakeDenoHost(overrides: Partial<DenoHost> = {}): DenoHost {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(['/tmp']);

  return {
    version: { deno: '2.7.5' },
    hostname: () => 'deno-host',
    env: {
      toObject: () => ({ HOME: '/home/user', PATH: '/usr/bin' }),
    },
    exit: (code?: number) => {
      throw new Error(`exit called with code ${code ?? 0}`);
    },
    readFile: (path: string) => {
      const data = files.get(path);
      if (data === undefined) {
        return Promise.reject(new Error(`ENOENT: ${path}`));
      }
      return Promise.resolve(data);
    },
    realPath: (path: string) => {
      if (files.has(path) || dirs.has(path)) {
        return Promise.resolve(path);
      }
      return Promise.reject(new Error(`ENOENT: ${path}`));
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
        return [];
      }
      const entries: { name: string }[] = [];
      for (const key of files.keys()) {
        if (key.startsWith(path + '/')) {
          entries.push({ name: key.split('/').pop()! });
        }
      }
      return entries;
    },
    mkdir: (path: string) => {
      dirs.add(path);
      return Promise.resolve();
    },
    remove: (path: string) => {
      files.delete(path);
      dirs.delete(path);
      return Promise.resolve();
    },
    ...overrides,
  };
}

describe('createDenoRuntimeServices', () => {
  it('returns platform "deno"', () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    expect(services.platform()).toBe('deno');
  });

  it('returns the Deno version', () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    expect(services.version()).toBe('2.7.5');
  });

  it('returns the hostname', () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    expect(services.hostname()).toBe('deno-host');
  });

  it('returns environment variables', () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    expect(services.env.HOME).toBe('/home/user');
    expect(services.env.PATH).toBe('/usr/bin');
  });

  it('exit throws via the host', () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    expect(() => services.exit(1)).toThrow('exit called with code 1');
  });

  it('exit with no code defaults to 0', () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    expect(() => services.exit()).toThrow('exit called with code 0');
  });

  it('fs.readFile reads a written file', async () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    const fs = services.fs!;
    await fs.writeFile('/test.txt', new Uint8Array([1, 2, 3]));
    const data = await fs.readFile('/test.txt');
    expect(Array.from(data)).toEqual([1, 2, 3]);
  });

  it('fs.readFile rejects for missing file', async () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    const fs = services.fs!;
    await expect(fs.readFile('/missing.txt')).rejects.toThrow('ENOENT');
  });

  it('fs.realPath resolves an existing path and rejects a missing one', async () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    const fs = services.fs!;
    await fs.writeFile('/real.txt', new Uint8Array([1]));
    expect(await fs.realPath!('/real.txt')).toBe('/real.txt');
    await expect(fs.realPath!('/missing.txt')).rejects.toThrow('ENOENT');
  });

  it('fs.stat returns file info', async () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    const fs = services.fs!;
    await fs.writeFile('/stat.txt', new Uint8Array([10, 20]));
    const stat = await fs.stat('/stat.txt');
    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
    expect(stat.size).toBe(2);
    expect(stat.mtime).toBeInstanceOf(Date);
  });

  it('fs.stat returns directory info', async () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    const fs = services.fs!;
    const stat = await fs.stat('/tmp');
    expect(stat.isDirectory).toBe(true);
    expect(stat.isFile).toBe(false);
  });

  it('fs.readdir lists entries', async () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    const fs = services.fs!;
    await fs.writeFile('/tmp/a.txt', new Uint8Array([1]));
    await fs.writeFile('/tmp/b.txt', new Uint8Array([2]));
    const entries = await fs.readdir('/tmp');
    expect(entries).toContain('a.txt');
    expect(entries).toContain('b.txt');
  });

  it('fs.mkdir creates a directory', async () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    const fs = services.fs!;
    await fs.mkdir('/newdir', { recursive: true });
    const stat = await fs.stat('/newdir');
    expect(stat.isDirectory).toBe(true);
  });

  it('fs.rm removes a file', async () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    const fs = services.fs!;
    await fs.writeFile('/rm.txt', new Uint8Array([1]));
    await fs.rm('/rm.txt');
    await expect(fs.readFile('/rm.txt')).rejects.toThrow();
  });

  it('fs.rm removes a directory recursively', async () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    const fs = services.fs!;
    await fs.mkdir('/rmdir', { recursive: true });
    await fs.rm('/rmdir', { recursive: true });
    await expect(fs.stat('/rmdir')).rejects.toThrow();
  });

  it('provides cross-runtime uuid', () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    expect(services.uuid()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('provides cross-runtime randomBytes', () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    expect(services.randomBytes(8).length).toBe(8);
  });

  it('provides cross-runtime subtle', () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    expect(services.subtle).toBeDefined();
  });

  it('provides cross-runtime now', () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    expect(services.now()).toBeGreaterThan(0);
  });

  it('provides cross-runtime hrtime', () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    expect(services.hrtime()).toBeGreaterThanOrEqual(0);
  });

  it('provides timers', () => {
    const services = createDenoRuntimeServices(createFakeDenoHost());
    expect(typeof services.setTimeout).toBe('function');
    expect(typeof services.clearTimeout).toBe('function');
    expect(typeof services.setInterval).toBe('function');
    expect(typeof services.clearInterval).toBe('function');
  });
});

describe('createDenoRuntimeServices — mtime null branch', () => {
  it('omits mtime when stat returns mtime: null', async () => {
    const host: DenoHost = {
      version: { deno: '2.7.5' },
      hostname: () => 'host',
      env: { toObject: () => ({}) },
      exit: () => {
        throw new Error('exit');
      },
      readFile: () => Promise.resolve(new Uint8Array()),
      realPath: (path: string) => Promise.resolve(path),
      writeFile: () => Promise.resolve(),
      stat: () =>
        Promise.resolve({
          isFile: true,
          isDirectory: false,
          size: 0,
          mtime: null,
        }),
      readdir: () => [],
      mkdir: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const services = createDenoRuntimeServices(host);
    const info = await services.fs!.stat('/any');
    expect(info.isFile).toBe(true);
    expect('mtime' in info).toBe(false);
  });
});
