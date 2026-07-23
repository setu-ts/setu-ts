/**
 * Tests for FileAuditStorage.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { FileAuditStorage } from '../../src/storage/file-audit.ts';
import type { IFileSystem } from '@hono-enterprise/common';

describe('FileAuditStorage', () => {
  function makeFakeFs(files: Record<string, string>): IFileSystem {
    return {
      readFile: (path: string) => {
        const content = files[path] ?? '';
        return Promise.resolve(new TextEncoder().encode(content));
      },
      writeFile: (path: string, data: Uint8Array) => {
        files[path] = new TextDecoder().decode(data);
        return Promise.resolve();
      },
      stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 0 }),
      readdir: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
    };
  }

  it('throws when constructed without fs', () => {
    const fakeFs = undefined as never;
    expect(() => new FileAuditStorage({ fs: fakeFs })).toThrow(
      'FileAuditStorage requires runtime.fs which is absent on edge platforms',
    );
  });

  it('append does read-modify-write', async () => {
    const files: Record<string, string> = {};
    const fs = makeFakeFs(files);
    const storage = new FileAuditStorage({ fs });

    await storage.append({
      id: '1',
      timestamp: 100,
      action: 'a',
      resource: 'r',
      result: 'success',
    });

    const content = files['./audit.log'];
    const lines = content!.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).id).toBe('1');
  });

  it('multiple appends accumulate lines', async () => {
    const files: Record<string, string> = {};
    const fs = makeFakeFs(files);
    const storage = new FileAuditStorage({ fs });

    await storage.append({
      id: '1',
      timestamp: 100,
      action: 'a',
      resource: 'r',
      result: 'success',
    });
    await storage.append({
      id: '2',
      timestamp: 200,
      action: 'b',
      resource: 'r',
      result: 'failure',
    });

    const content = files['./audit.log'];
    const lines = content!.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(2);
  });

  it('absent file treated as empty', async () => {
    const files: Record<string, string> = {};
    const fs = makeFakeFs(files);
    const storage = new FileAuditStorage({ fs, path: './nonexistent.log' });

    await storage.append({
      id: '1',
      timestamp: 100,
      action: 'a',
      resource: 'r',
      result: 'success',
    });

    const expected = JSON.stringify({
      id: '1',
      timestamp: 100,
      action: 'a',
      resource: 'r',
      result: 'success',
    }) + '\n';
    expect(files['./nonexistent.log']).toBe(expected);
  });

  it('query reads, filters, returns frozen records', async () => {
    const files: Record<string, string> = {};
    const fs = makeFakeFs(files);
    const storage = new FileAuditStorage({ fs });

    await storage.append({
      id: '1',
      timestamp: 100,
      action: 'user.create',
      resource: 'user',
      result: 'success',
    });
    await storage.append({
      id: '2',
      timestamp: 200,
      action: 'user.delete',
      resource: 'user',
      result: 'failure',
    });

    const results = await storage.query({ action: 'user.create' });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('1');

    // Verify frozen.
    expect(() => {
      // biome-ignore lint/perf/noMutation: testing immutability
      (results[0] as unknown as Record<string, unknown>).id = 'tampered';
    }).toThrow();
  });

  it('query returns [] for missing file', async () => {
    const files: Record<string, string> = {};
    const fs = makeFakeFs(files);
    const storage = new FileAuditStorage({ fs, path: './missing.log' });
    const results = await storage.query();
    expect(results).toEqual([]);
  });

  it('appended record matches query by timestamp range', async () => {
    const files: Record<string, string> = {};
    const fs = makeFakeFs(files);
    const storage = new FileAuditStorage({ fs });

    await storage.append({
      id: '1',
      timestamp: 100,
      action: 'a',
      resource: 'r',
      result: 'success',
    });
    await storage.append({
      id: '2',
      timestamp: 200,
      action: 'b',
      resource: 'r',
      result: 'success',
    });
    await storage.append({
      id: '3',
      timestamp: 300,
      action: 'c',
      resource: 'r',
      result: 'success',
    });

    const results = await storage.query({ from: 150, to: 250 });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('2');
  });

  it('query with limit returns newest', async () => {
    const files: Record<string, string> = {};
    const fs = makeFakeFs(files);
    const storage = new FileAuditStorage({ fs });

    for (let i = 1; i <= 3; i++) {
      await storage.append({
        id: String(i),
        timestamp: i * 100,
        action: 'a',
        resource: 'r',
        result: 'success',
      });
    }

    const results = await storage.query({ limit: 2 });
    expect(results.length).toBe(2);
    expect(results[0].id).toBe('2');
    expect(results[1].id).toBe('3');
  });
});
