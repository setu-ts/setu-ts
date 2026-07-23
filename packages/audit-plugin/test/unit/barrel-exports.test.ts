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
  AuditStorageOptions,
  AuditStorageType,
  IAuditDbClient,
  IAuditLogger,
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
});
