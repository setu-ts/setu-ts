import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createBunRuntimeServices } from '../../src/adapters/bun/bun-runtime.ts';
import type { BunHost } from '../../src/adapters/bun/bun-runtime.ts';

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
});
