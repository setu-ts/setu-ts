/**
 * Tests for AuditService — verifies log() stamps id/timestamp, freezes, and
 * delegates to storage.append.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { AuditService } from '../../src/services/audit-service.ts';
import type { AuditQuery, IAuditStorage, StoredAuditEntry } from '../../src/interfaces/index.ts';
import type { IRuntimeServices } from '@hono-enterprise/common';

describe('AuditService', () => {
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
      append: async (entry: StoredAuditEntry) => {
        appends.push(entry);
      },
      query: async (_criteria?: AuditQuery) => appends,
      isReady: () => true,
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
      append: async () => {
        throw new Error('storage down');
      },
      query: async () => [],
      isReady: () => true,
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
});
