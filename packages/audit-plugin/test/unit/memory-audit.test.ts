/**
 * Tests for MemoryAuditStorage.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryAuditStorage } from '../../src/storage/memory-audit.ts';
import type { StoredAuditEntry } from '../../src/interfaces/index.ts';

describe('MemoryAuditStorage', () => {
  it('append then query() returns the entry', async () => {
    const storage = new MemoryAuditStorage();
    const entry: StoredAuditEntry = {
      id: '1',
      timestamp: 100,
      action: 'user.create',
      resource: 'user',
      result: 'success',
    };
    await storage.append(entry);
    const results = await storage.query();
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('1');
    expect(results[0].action).toBe('user.create');
  });

  it('query(criteria) filters via matchAuditQuery', async () => {
    const storage = new MemoryAuditStorage();
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
  });

  it('isReady() returns true', () => {
    const storage = new MemoryAuditStorage();
    expect(storage.isReady()).toBe(true);
  });

  it('multiple entries preserve order', async () => {
    const storage = new MemoryAuditStorage();
    for (let i = 1; i <= 5; i++) {
      await storage.append({
        id: String(i),
        timestamp: i * 100,
        action: 'a',
        resource: 'r',
        result: 'success',
      });
    }
    const results = await storage.query();
    expect(results.map((r) => r.id)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('query with limit returns newest limit', async () => {
    const storage = new MemoryAuditStorage();
    for (let i = 1; i <= 5; i++) {
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
    expect(results[0].id).toBe('4');
    expect(results[1].id).toBe('5');
  });

  it('query with limit: 0 returns none', async () => {
    const storage = new MemoryAuditStorage();
    await storage.append({
      id: '1',
      timestamp: 100,
      action: 'a',
      resource: 'r',
      result: 'success',
    });
    const results = await storage.query({ limit: 0 });
    expect(results.length).toBe(0);
  });

  it('close() resolves (no-op)', async () => {
    const storage = new MemoryAuditStorage();
    await expect(storage.close()).resolves.toBeUndefined();
  });

  it('query with from/to filters by timestamp range', async () => {
    const storage = new MemoryAuditStorage();
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
});
