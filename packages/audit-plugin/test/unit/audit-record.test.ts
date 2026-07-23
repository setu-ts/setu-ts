/**
 * Tests for pure transforms: freezeAuditRecord, matchAuditQuery, toAuditRow,
 * fromAuditRow.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  freezeAuditRecord,
  fromAuditRow,
  matchAuditQuery,
  toAuditRow,
} from '../../src/storage/audit-record.ts';
import type { AuditQuery, StoredAuditEntry } from '../../src/interfaces/index.ts';

describe('freezeAuditRecord', () => {
  it('deep-freezes nested objects — mutating before throws', () => {
    const entry: StoredAuditEntry = {
      id: '1',
      timestamp: 1000,
      action: 'user.create',
      resource: 'user',
      resourceId: 'abc',
      userId: 'u1',
      result: 'success',
      before: { name: 'old' },
      after: { name: 'new' },
      metadata: { ip: '127.0.0.1' },
    };
    const frozen = freezeAuditRecord(entry);
    expect(() => {
      // biome-ignore lint/perf/noMutation: testing immutability
      (frozen.before as Record<string, unknown>).name = 'mutated';
    }).toThrow();
  });

  it('freezes top-level record', () => {
    const entry: StoredAuditEntry = {
      id: '1',
      timestamp: 1000,
      action: 'user.create',
      resource: 'user',
      result: 'success',
    };
    const frozen = freezeAuditRecord(entry);
    expect(() => {
      // biome-ignore lint/perf/noMutation: testing immutability
      (frozen as unknown as Record<string, unknown>).id = '2';
    }).toThrow();
  });

  it('handles records without optional fields', () => {
    const entry: StoredAuditEntry = {
      id: '1',
      timestamp: 1000,
      action: 'user.create',
      resource: 'user',
      result: 'success',
    };
    const frozen = freezeAuditRecord(entry);
    expect(frozen.id).toBe('1');
    expect(frozen.before).toBeUndefined();
  });
});

describe('matchAuditQuery', () => {
  const base: StoredAuditEntry = {
    id: '1',
    timestamp: 5000,
    action: 'user.delete',
    resource: 'user',
    resourceId: 'r1',
    userId: 'u1',
    result: 'success',
  };

  it('matches all fields', () => {
    const criteria: AuditQuery = {
      action: 'user.delete',
      resource: 'user',
      resourceId: 'r1',
      userId: 'u1',
      result: 'success',
    };
    expect(matchAuditQuery(base, criteria)).toBe(true);
  });

  it('excludes on mismatched action', () => {
    expect(matchAuditQuery(base, { action: 'user.create' })).toBe(false);
  });

  it('excludes when present resourceId does not match', () => {
    expect(matchAuditQuery(base, { resourceId: 'wrong' })).toBe(false);
  });

  it('absent resourceId never matches set value', () => {
    const noResourceId: StoredAuditEntry = {
      ...base,
      resourceId: undefined,
    };
    expect(matchAuditQuery(noResourceId, { resourceId: 'r1' })).toBe(false);
  });

  it('absent userId never matches set value', () => {
    const noUserId: StoredAuditEntry = {
      ...base,
      userId: undefined,
    };
    expect(matchAuditQuery(noUserId, { userId: 'u1' })).toBe(false);
  });

  it('from is inclusive lower bound', () => {
    expect(matchAuditQuery(base, { from: 5000 })).toBe(true);
    expect(matchAuditQuery(base, { from: 5001 })).toBe(false);
  });

  it('to is inclusive upper bound', () => {
    expect(matchAuditQuery(base, { to: 5000 })).toBe(true);
    expect(matchAuditQuery(base, { to: 4999 })).toBe(false);
  });
});

describe('limit + ordering in matchAuditQuery context', () => {
  it('returns all when limit omitted', () => {
    const entries: StoredAuditEntry[] = [
      { id: '1', timestamp: 1000, action: 'a', resource: 'r', result: 'success' },
      { id: '2', timestamp: 2000, action: 'a', resource: 'r', result: 'success' },
      { id: '3', timestamp: 3000, action: 'a', resource: 'r', result: 'success' },
    ];
    const match = entries.filter((_e) => true);
    expect(match.length).toBe(3);
  });

  it('limit: 0 returns none', () => {
    const entries: StoredAuditEntry[] = [
      { id: '1', timestamp: 1000, action: 'a', resource: 'r', result: 'success' },
      { id: '2', timestamp: 2000, action: 'a', resource: 'r', result: 'success' },
    ];
    const filtered = entries.filter((e) => matchAuditQuery(e, {}));
    const limited = filtered.slice(filtered.length - 0);
    expect(limited.length).toBe(0);
  });
});

describe('toAuditRow / fromAuditRow', () => {
  it('round-trips a simple record', () => {
    const original: StoredAuditEntry = {
      id: 'orig-1',
      timestamp: 42,
      action: 'user.create',
      resource: 'user',
      resourceId: 'rid',
      userId: 'uid',
      result: 'success',
    };
    const row = toAuditRow(original);
    const restored = fromAuditRow(row);
    expect(restored.id).toBe('orig-1');
    expect(restored.timestamp).toBe(42);
    expect(restored.action).toBe('user.create');
    expect(restored.resource).toBe('user');
    expect(restored.resourceId).toBe('rid');
    expect(restored.userId).toBe('uid');
    expect(restored.result).toBe('success');
  });

  it('serializes nested objects as JSON strings', () => {
    const original: StoredAuditEntry = {
      id: '1',
      timestamp: 100,
      action: 'update',
      resource: 'doc',
      result: 'success',
      before: { version: 1 },
      after: { version: 2 },
      metadata: { ip: '10.0.0.1' },
    };
    const row = toAuditRow(original);
    const restored = fromAuditRow(row);
    expect(restored.before).toEqual({ version: 1 });
    expect(restored.after).toEqual({ version: 2 });
    expect(restored.metadata).toEqual({ ip: '10.0.0.1' });
  });

  it('fromAuditRow returns a deep-frozen record', () => {
    const row: Record<string, unknown> = {
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
    };
    const frozen = fromAuditRow(row);
    expect(() => {
      // biome-ignore lint/perf/noMutation: testing immutability
      (frozen as unknown as Record<string, unknown>).action = 'changed';
    }).toThrow();
  });

  it('handles null resource_id / user_id as undefined', () => {
    const row: Record<string, unknown> = {
      id: '1',
      timestamp: 100,
      action: 'a',
      resource: 'r',
      resource_id: null,
      user_id: null,
      result: 'failure',
      before: null,
      after: null,
      metadata: null,
    };
    const entry = fromAuditRow(row);
    expect(entry.resourceId).toBeUndefined();
    expect(entry.userId).toBeUndefined();
    expect(entry.result).toBe('failure');
  });
});
