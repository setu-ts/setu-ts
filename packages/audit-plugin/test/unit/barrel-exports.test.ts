/**
 * Barrel exports — every documented symbol is exported and defined.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  AuditPlugin,
  AuditService,
  DatabaseAuditStorage,
  FileAuditStorage,
  LogAuditStorage,
  MemoryAuditStorage,
} from '../../src/index.ts';
import type {
  AuditEntry,
  AuditPluginOptions,
  AuditQuery,
  AuditStorageOptions,
  AuditStorageType,
  IAuditDbClient,
  IAuditLogger,
  StoredAuditEntry,
} from '../../src/index.ts';

describe('barrel exports', () => {
  it('exports AuditPlugin factory', () => {
    expect(AuditPlugin).toBeDefined();
    expect(typeof AuditPlugin).toBe('function');
  });

  it('exports AuditService class', () => {
    expect(AuditService).toBeDefined();
    expect(typeof AuditService).toBe('function');
  });

  it('exports MemoryAuditStorage class', () => {
    expect(MemoryAuditStorage).toBeDefined();
    expect(typeof MemoryAuditStorage).toBe('function');
  });

  it('exports LogAuditStorage class', () => {
    expect(LogAuditStorage).toBeDefined();
    expect(typeof LogAuditStorage).toBe('function');
  });

  it('exports DatabaseAuditStorage class', () => {
    expect(DatabaseAuditStorage).toBeDefined();
    expect(typeof DatabaseAuditStorage).toBe('function');
  });

  it('exports FileAuditStorage class', () => {
    expect(FileAuditStorage).toBeDefined();
    expect(typeof FileAuditStorage).toBe('function');
  });

  it('IAuditDbClient type compiles', () => {
    const _check: { _type: IAuditDbClient } | null = null;
    expect(_check).toBeNull();
  });

  it('AuditPluginOptions type compiles', () => {
    const opts: AuditPluginOptions = { storage: 'memory' };
    expect(opts.storage).toBe('memory');
  });

  it('AuditStorageType type compiles', () => {
    const type: AuditStorageType = 'log';
    expect(type).toBe('log');
  });

  it('AuditStorageOptions type compiles', () => {
    const opts: AuditStorageOptions = { table: 'custom', path: './log.jsonl' };
    expect(opts.table).toBe('custom');
  });

  it('re-exported IAuditLogger and AuditEntry types compile', () => {
    const _check: { logger: IAuditLogger; entry: AuditEntry } | null = null;
    expect(_check).toBeNull();
  });

  // M70n X4-7: compile-time assertions declared against the BARREL — a
  // runtime-only assertion leaves a dropped type export green.
  it('StoredAuditEntry type is nameable from the barrel', () => {
    const entry: StoredAuditEntry = {
      id: 'entry-1',
      timestamp: 0,
      action: 'user.login',
      resource: 'session',
      result: 'success',
    };
    expect(entry.id).toBe('entry-1');
  });

  it('AuditQuery type is nameable from the barrel', () => {
    const query: AuditQuery = { action: 'user.login', limit: 10 };
    expect(query.limit).toBe(10);
  });

  it('storage query members are typed by the exported barrel types', () => {
    // The whole point of X4-7: the exported storage classes' `query` members'
    // parameter and return types must be NAMEABLE through the barrel.
    type QueryFn = (criteria?: AuditQuery) => Promise<StoredAuditEntry[]>;
    const query: QueryFn = MemoryAuditStorage.prototype.query;
    expect(typeof query).toBe('function');
  });
});
