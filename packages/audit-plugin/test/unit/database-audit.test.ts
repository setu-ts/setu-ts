/**
 * Tests for DatabaseAuditStorage.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DatabaseAuditStorage } from '../../src/storage/database-audit.ts';
import { FakeAuditDbClient } from '../fixtures/fake-audit-db-client.ts';
import type { StoredAuditEntry } from '../../src/interfaces/index.ts';

describe('DatabaseAuditStorage', () => {
  it('throws when constructed without client', () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing missing client
    expect(() => new DatabaseAuditStorage({ client: undefined as never })).toThrow(
      'DatabaseAuditStorage requires an injected IAuditDbClient',
    );
  });

  it('append calls client.insert with serialized row', async () => {
    const client = new FakeAuditDbClient();
    const storage = new DatabaseAuditStorage({ client });
    const entry: StoredAuditEntry = {
      id: 'e1',
      timestamp: 100,
      action: 'user.create',
      resource: 'user',
      resourceId: 'r1',
      userId: 'u1',
      result: 'success',
    };
    await storage.append(entry);

    expect(client.inserts.length).toBe(1);
    const row = client.inserts[0].row;
    expect(row.id).toBe('e1');
    expect(row.timestamp).toBe(100);
    expect(row.action).toBe('user.create');
  });

  it('select returns frozen records via query', async () => {
    const client = new FakeAuditDbClient();
    const storage = new DatabaseAuditStorage({ client, table: 'audit_logs' });

    const row: Record<string, unknown> = {
      id: 'q1',
      timestamp: 500,
      action: 'login',
      resource: 'auth',
      resource_id: null,
      user_id: 'u2',
      result: 'success',
      before: null,
      after: null,
      metadata: null,
    };
    await client.insert('audit_logs', row);

    const results = await storage.query();
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('q1');
    expect(results[0].result).toBe('success');

    // Verify frozen.
    expect(() => {
      // biome-ignore lint/perf/noMutation: testing immutability
      (results[0] as unknown as Record<string, unknown>).id = 'tampered';
    }).toThrow();
  });

  it('table option is threaded', async () => {
    const client = new FakeAuditDbClient();
    const storage = new DatabaseAuditStorage({ client, table: 'custom_audit' });
    await storage.append({
      id: '1',
      timestamp: 100,
      action: 'a',
      resource: 'r',
      result: 'success',
    });
    expect(client.inserts[0].table).toBe('custom_audit');
  });

  it('isReady returns true', () => {
    const client = new FakeAuditDbClient();
    const storage = new DatabaseAuditStorage({ client });
    expect(storage.isReady()).toBe(true);
  });

  it('query filters by from/to on mapped results', async () => {
    const client = new FakeAuditDbClient();
    const storage = new DatabaseAuditStorage({ client, table: 'audit_logs' });
    await client.insert('audit_logs', {
      id: 'r1',
      timestamp: 100,
      action: 'a',
      resource: 'r',
      resource_id: null,
      user_id: null,
      result: 'success',
      before: null,
      after: null,
      metadata: null,
    });
    await client.insert('audit_logs', {
      id: 'r2',
      timestamp: 500,
      action: 'b',
      resource: 'r',
      resource_id: null,
      user_id: null,
      result: 'success',
      before: null,
      after: null,
      metadata: null,
    });
    await client.insert('audit_logs', {
      id: 'r3',
      timestamp: 900,
      action: 'c',
      resource: 'r',
      resource_id: null,
      user_id: null,
      result: 'failure',
      before: null,
      after: null,
      metadata: null,
    });
    const results = await storage.query({ from: 200, to: 600 });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('r2');
  });
});

it('query filters by from/to on mapped results', async () => {
  const client = new FakeAuditDbClient();
  const storage = new DatabaseAuditStorage({ client, table: 'audit_logs' });

  await client.insert('audit_logs', {
    id: 'r1',
    timestamp: 100,
    action: 'a',
    resource: 'r',
    resource_id: null,
    user_id: null,
    result: 'success',
    before: null,
    after: null,
    metadata: null,
  });
  await client.insert('audit_logs', {
    id: 'r2',
    timestamp: 500,
    action: 'b',
    resource: 'r',
    resource_id: null,
    user_id: null,
    result: 'success',
    before: null,
    after: null,
    metadata: null,
  });
  await client.insert('audit_logs', {
    id: 'r3',
    timestamp: 900,
    action: 'c',
    resource: 'r',
    resource_id: null,
    user_id: null,
    result: 'failure',
    before: null,
    after: null,
    metadata: null,
  });

  const results = await storage.query({ from: 200, to: 600 });
  expect(results.length).toBe(1);
  expect(results[0].id).toBe('r2');
});

it('query with limit returns newest limit', async () => {
  const client = new FakeAuditDbClient();
  const storage = new DatabaseAuditStorage({ client });

  await client.insert('audit_logs', {
    id: '1',
    timestamp: 100,
    action: 'a',
    resource: 'r',
    resource_id: null,
    user_id: null,
    result: 'success',
    before: null,
    after: null,
    metadata: null,
  });
  await client.insert('audit_logs', {
    id: '2',
    timestamp: 200,
    action: 'b',
    resource: 'r',
    resource_id: null,
    user_id: null,
    result: 'success',
    before: null,
    after: null,
    metadata: null,
  });
  await client.insert('audit_logs', {
    id: '3',
    timestamp: 300,
    action: 'c',
    resource: 'r',
    resource_id: null,
    user_id: null,
    result: 'success',
    before: null,
    after: null,
    metadata: null,
  });

  const results = await storage.query({ limit: 2 });
  expect(results.length).toBe(2);
  expect(results[0].id).toBe('2');
  expect(results[1].id).toBe('3');
});
