/**
 * Tests for AuditService — verifies log() stamps id/timestamp, freezes, and
 * delegates to storage.append.
 */
import { describe, expect, it } from 'vitest';
import { AuditService } from '../../src/services/audit-service.ts';
import type { AuditQuery, IAuditStorage, StoredAuditEntry } from '../../src/interfaces/index.ts';
import type { IRuntimeServices } from '@setu-ts/common';
import { createRedactionService } from '@setu-ts/common';
import { vi } from 'vitest';
import {
  AuditScopeUnsupportedError,
  MemoryAuditStorage,
  LogAuditStorage,
  FileAuditStorage,
} from '../../src/index.ts';

describe('AuditService', () => {
  it('refuses scopes on memory, log and file without calling append or writing', async () => {
    const writeFile = vi.fn(() => Promise.resolve());
    const fs = {
      readFile: () => Promise.resolve(new Uint8Array()),
      writeFile,
      stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 0 }),
      readdir: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
    };
    const scope = {
      getRepository: vi.fn(() => ({ create: () => Promise.reject(new Error('unreachable')) })),
    };
    for (const storage of [
      new MemoryAuditStorage(),
      new LogAuditStorage(),
      new FileAuditStorage({ fs }),
    ]) {
      const append = vi.spyOn(storage, 'append');
      const service = new AuditService(storage, fakeRuntime);
      await expect(
        service.log({ action: 'update', resource: 'account', result: 'success' }, { scope }),
      ).rejects.toBeInstanceOf(AuditScopeUnsupportedError);
      expect(append).not.toHaveBeenCalled();
      expect(await storage.query()).toEqual([]);
    }
    expect(writeFile).not.toHaveBeenCalled();
    expect(scope.getRepository).not.toHaveBeenCalled();
    expect(new AuditScopeUnsupportedError().name).toBe('AuditScopeUnsupportedError');
  });
  const fakeRuntime: IRuntimeServices = {
    platform: () => 'node' as never,
    version: () => '1.0.0',
    hostname: () => 'localhost',
    uuid: () => 'test-uuid-1234',
    randomBytes: () => new Uint8Array([1, 2]),
    subtle: {} as SubtleCrypto,
    now: () => 1700000000000,
    hrtime: () => 12345,
    setTimeout: () => 1 as never,
    clearTimeout: () => {},
    setInterval: () => 2 as never,
    clearInterval: () => {},
    env: {},
    exit: () => {
      throw new Error('exit called');
    },
  };

  function makeFakeStorage(): {
    storage: IAuditStorage;
    appends: StoredAuditEntry[];
  } {
    const appends: StoredAuditEntry[] = [];
    const storage: IAuditStorage = {
      append(entry: StoredAuditEntry): Promise<void> {
        appends.push(entry);
        return Promise.resolve();
      },
      query(_criteria?: AuditQuery): Promise<StoredAuditEntry[]> {
        return Promise.resolve(appends);
      },
      isReady() {
        return true;
      },
      close() {
        return Promise.resolve();
      },
    };
    return { storage, appends };
  }

  it('log() calls storage.append with stamped & frozen record', async () => {
    const { storage, appends } = makeFakeStorage();
    const service = new AuditService(storage, fakeRuntime);

    await service.log({
      action: 'user.delete',
      resource: 'user',
      resourceId: 'r1',
      userId: 'u1',
      result: 'success',
    });

    expect(appends.length).toBe(1);
    const entry = appends[0];
    expect(entry.id).toBe('test-uuid-1234');
    expect(entry.timestamp).toBe(1700000000000);
    expect(entry.action).toBe('user.delete');
    expect(entry.result).toBe('success');

    // Verify frozen — mutation should throw.
    expect(() => {
      // biome-ignore lint/perf/noMutation: testing immutability
      (entry as unknown as Record<string, unknown>).id = 'modified';
    }).toThrow();
  });

  it('passes failure result through', async () => {
    const { storage, appends } = makeFakeStorage();
    const service = new AuditService(storage, fakeRuntime);

    await service.log({
      action: 'login',
      resource: 'auth',
      result: 'failure',
    });

    expect(appends[0].result).toBe('failure');
  });

  it('propagates storage rejection', async () => {
    const storage: IAuditStorage = {
      append(): Promise<void> {
        throw new Error('storage down');
      },
      query(): Promise<StoredAuditEntry[]> {
        return Promise.resolve([]);
      },
      close() {
        return Promise.resolve();
      },
      isReady() {
        return true;
      },
    };
    const service = new AuditService(storage, fakeRuntime);

    await expect(service.log({ action: 'x', resource: 'y', result: 'success' })).rejects.toThrow(
      'storage down',
    );
  });

  it('each log gets a fresh id', async () => {
    let counter = 0;
    const { storage, appends } = makeFakeStorage();
    const svc = new AuditService(storage, {
      ...fakeRuntime,
      uuid: () => 'uuid-' + ++counter,
    });

    await svc.log({ action: 'a', resource: 'r', result: 'success' });
    await svc.log({ action: 'b', resource: 'r', result: 'success' });

    expect(appends[0].id).not.toBe(appends[1].id);
  });

  it('redacts before, after, and metadata before freezing the record', async () => {
    const { storage, appends } = makeFakeStorage();
    const service = new AuditService(
      storage,
      fakeRuntime,
      createRedactionService({ fields: { password: 'secret', 'profile.email': 'pii' } }),
    );

    await service.log({
      action: 'user.update',
      resource: 'user',
      result: 'success',
      before: { password: 'old' },
      after: { profile: { email: 'user@example.test' } },
      metadata: { password: 'metadata-secret' },
    });

    expect(appends[0]?.before).toEqual({ password: '[Redacted]' });
    expect(appends[0]?.after).toEqual({ profile: { email: '[Redacted]' } });
    expect(appends[0]?.metadata).toEqual({ password: '[Redacted]' });
    expect(Object.isFrozen(appends[0])).toBe(true);
  });

  it('keeps all optional bodies unchanged when no redaction service is supplied', async () => {
    const { storage, appends } = makeFakeStorage();
    const service = new AuditService(storage, fakeRuntime);
    const before = { password: 'before' };
    const after = { password: 'after' };
    const metadata = { password: 'metadata' };

    await service.log({
      action: 'user.update',
      resource: 'user',
      result: 'success',
      before,
      after,
      metadata,
    });

    expect(appends[0]?.before).toEqual(before);
    expect(appends[0]?.after).toEqual(after);
    expect(appends[0]?.metadata).toEqual(metadata);
  });
});
