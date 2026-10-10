/**
 * The scoped RBAC sources (M110b plan §3.16) over a REAL `DatabaseService` on
 * the memory adapter, so the filter each builds is evaluated rather than only
 * recorded: chain and global rows, the `all` question, custom-role grouping,
 * field overrides, construction refusals and the dead-deadline check.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IServiceRegistry, ScopeRef } from '@setu-ts/common';
import type { IDatabaseService } from '../../src/interfaces/index.ts';
import {
  createDatabaseGrantSource,
  createDatabaseRoleSource,
} from '../../src/authorization/database-grant-source.ts';
import { memoryService } from '../fixtures/inbox-store.ts';

const T1: ScopeRef = { type: 'tenant', id: 't1' };
const T2: ScopeRef = { type: 'tenant', id: 't2' };
const live = new AbortController().signal;

function registry(service: IDatabaseService): IServiceRegistry {
  return {
    get: (token: string) => {
      expect(token).toBe(CAPABILITIES.DATABASE);
      return service;
    },
  } as unknown as IServiceRegistry;
}

async function seededGrants(): Promise<IDatabaseService> {
  const service = await memoryService();
  const repo = service.getRepository<Record<string, unknown>>('grants');
  for (
    const row of [
      { id: 'g1', subject: 'u1', role: 'approver', scopeType: 'tenant', scopeId: 't1' },
      { id: 'g2', subject: 'u1', role: 'viewer', scopeType: null, scopeId: null },
      { id: 'g3', subject: 'u1', role: 'owner', scopeType: 'tenant', scopeId: 't2' },
      { id: 'g4', subject: 'u2', role: 'owner', scopeType: 'tenant', scopeId: 't1' },
      { id: 'g5', subject: 'u1', role: 'broken', scopeType: 'tenant', scopeId: null },
    ]
  ) {
    await repo.create(row);
  }
  return service;
}

describe('createDatabaseGrantSource', () => {
  it('answers a chain question with the subject’s grants in the chain plus its global ones', async () => {
    const source = createDatabaseGrantSource({ entity: 'grants' })(registry(await seededGrants()));
    const grants = await source.grantsFor({ id: 'u1' }, { kind: 'chain', scopes: [T1] }, live);
    expect(grants).toEqual([
      { role: 'approver', scope: T1 },
      { role: 'viewer', scope: null },
    ]);
    expect(source.name).toBe('database-grants');
  });

  it('answers only global grants for an empty chain', async () => {
    const source = createDatabaseGrantSource({ entity: 'grants' })(registry(await seededGrants()));
    expect(await source.grantsFor({ id: 'u1' }, { kind: 'chain', scopes: [] }, live)).toEqual([
      { role: 'viewer', scope: null },
    ]);
  });

  it('answers every grant of the subject for an all question, leaving a malformed row for the validator', async () => {
    const source = createDatabaseGrantSource({ entity: 'grants', name: 'grants' })(
      registry(await seededGrants()),
    );
    const grants = await source.grantsFor({ id: 'u1' }, { kind: 'all' }, live);
    expect(grants).toEqual([
      { role: 'approver', scope: T1 },
      { role: 'viewer', scope: null },
      { role: 'owner', scope: T2 },
      { role: 'broken', scope: { type: 'tenant', id: '' } },
    ]);
    expect(source.name).toBe('grants');
  });

  it('never returns another subject’s rows', async () => {
    const source = createDatabaseGrantSource({ entity: 'grants' })(registry(await seededGrants()));
    const grants = await source.grantsFor({ id: 'nobody' }, { kind: 'all' }, live);
    expect(grants).toEqual([]);
  });

  it('reads overridden column names, and refuses rather than truncates past the limit', async () => {
    const service = await memoryService();
    const repo = service.getRepository<Record<string, unknown>>('acl');
    await repo.create({ id: 'a', who: 'u1', grant: 'viewer', kind: null, ref: null });
    await repo.create({ id: 'b', who: 'u1', grant: 'owner', kind: null, ref: null });
    const source = createDatabaseGrantSource({
      entity: 'acl',
      fields: { subject: 'who', role: 'grant', scopeType: 'kind', scopeId: 'ref' },
      limit: 2,
    })(registry(service));
    expect(await source.grantsFor({ id: 'u1' }, { kind: 'chain', scopes: [] }, live)).toEqual([
      { role: 'viewer', scope: null },
      { role: 'owner', scope: null },
    ]);
    // A third matching row exceeds the limit: the question is refused, never
    // answered with an arbitrary two of the three.
    await repo.create({ id: 'c', who: 'u1', grant: 'auditor', kind: null, ref: null });
    await expect(source.grantsFor({ id: 'u1' }, { kind: 'chain', scopes: [] }, live)).rejects
      .toThrow('createDatabaseGrantSource: more than 2 rows match; the question is refused');
  });

  it('the role source refuses rather than truncates past its limit', async () => {
    const service = await memoryService();
    const repo = service.getRepository<Record<string, unknown>>('roles');
    const T = { type: 'tenant', id: 't1' };
    await repo.create({ id: '1', scopeType: 't', scopeId: 'x', role: 'r', permission: 'a' });
    await repo.create({ id: '2', scopeType: 't', scopeId: 'x', role: 'r', permission: 'b' });
    const source = createDatabaseRoleSource({ entity: 'roles', limit: 1 })(registry(service));
    await expect(source.rolesFor([{ type: 't', id: 'x' }], live)).rejects.toThrow(
      'createDatabaseRoleSource: more than 1 rows match',
    );
    expect(await source.rolesFor([T], live)).toEqual([]);
  });

  it('refuses a non-string principal or scope id before querying, so no object reaches a filter', async () => {
    let queried = 0;
    const service = {
      getRepository: () => ({
        findAll: () => {
          queried += 1;
          return Promise.resolve([]);
        },
      }),
    } as unknown as IDatabaseService;
    const grants = createDatabaseGrantSource({ entity: 'grants' })(registry(service));
    const roles = createDatabaseRoleSource({ entity: 'roles' })(registry(service));
    // Prisma reads `{ not: 'nobody' }` as an operator matching every other subject's rows.
    const operator = { not: 'nobody' } as unknown as string;
    await expect(grants.grantsFor({ id: operator }, { kind: 'all' }, live)).rejects.toThrow(
      'subject must be compared with a string',
    );
    await expect(
      grants.grantsFor(
        { id: 'u1' },
        { kind: 'chain', scopes: [{ type: 'tenant', id: operator }] },
        live,
      ),
    ).rejects.toThrow('scopeId must be compared with a string');
    await expect(roles.rolesFor([{ type: operator, id: 't1' }], live)).rejects.toThrow(
      'scopeType must be compared with a string',
    );
    expect(queried).toBe(0);
  });

  it('refuses to start a query once the deadline has passed', async () => {
    const source = createDatabaseGrantSource({ entity: 'grants' })(registry(await seededGrants()));
    const controller = new AbortController();
    controller.abort();
    await expect(source.grantsFor({ id: 'u1' }, { kind: 'all' }, controller.signal)).rejects
      .toThrow(
        'deadline expired before the query',
      );
  });

  it('refuses an empty entity, a non-identifier field and an out-of-range limit', () => {
    expect(() => createDatabaseGrantSource({ entity: '' })).toThrow(
      'entity must be a non-empty string',
    );
    expect(() => createDatabaseGrantSource({ entity: 'g', fields: { subject: '$where' } })).toThrow(
      'field names must be identifiers',
    );
    expect(() => createDatabaseGrantSource({ entity: 'g', fields: { role: 'a.b' } })).toThrow(
      'field names must be identifiers',
    );
    expect(() => createDatabaseGrantSource({ entity: 'g', limit: 0 })).toThrow('limit must be');
    expect(() => createDatabaseGrantSource({ entity: 'g', limit: 10_002 })).toThrow(
      'limit must be',
    );
    expect(() => createDatabaseGrantSource({ entity: 'g', limit: 1.5 })).toThrow('limit must be');
  });
});

describe('createDatabaseRoleSource', () => {
  async function seededRoles(): Promise<IDatabaseService> {
    const service = await memoryService();
    const repo = service.getRepository<Record<string, unknown>>('roles');
    for (
      const row of [
        {
          id: 'r1',
          scopeType: 'tenant',
          scopeId: 't1',
          role: 'regional',
          permission: 'invoices:approve',
        },
        {
          id: 'r2',
          scopeType: 'tenant',
          scopeId: 't1',
          role: 'regional',
          permission: 'invoices:read',
        },
        {
          id: 'r3',
          scopeType: 'tenant',
          scopeId: 't2',
          role: 'regional',
          permission: 'invoices:read',
        },
        { id: 'r4', scopeType: 'tenant', scopeId: 't1', role: null, permission: 'x' },
      ]
    ) {
      await repo.create(row);
    }
    return service;
  }

  it('groups one row per permission into the roles each asked scope defines', async () => {
    const source = createDatabaseRoleSource({ entity: 'roles' })(registry(await seededRoles()));
    expect(await source.rolesFor([T1], live)).toEqual([
      { scope: T1, role: 'regional', permissions: ['invoices:approve', 'invoices:read'] },
    ]);
    expect(source.name).toBe('database-roles');
  });

  it('keeps two scopes defining the same name apart', async () => {
    const source = createDatabaseRoleSource({ entity: 'roles', name: 'roles' })(
      registry(await seededRoles()),
    );
    const roles = await source.rolesFor([T1, T2], live);
    expect(roles).toEqual([
      { scope: T1, role: 'regional', permissions: ['invoices:approve', 'invoices:read'] },
      { scope: T2, role: 'regional', permissions: ['invoices:read'] },
    ]);
  });

  it('makes no query for no scopes, and refuses a dead deadline', async () => {
    const source = createDatabaseRoleSource({ entity: 'roles' })(registry(await seededRoles()));
    expect(await source.rolesFor([], live)).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    await expect(source.rolesFor([T1], controller.signal)).rejects.toThrow('deadline expired');
  });

  it('refuses invalid construction', () => {
    expect(() => createDatabaseRoleSource({ entity: 'r', fields: { permission: 'p q' } })).toThrow(
      'field names must be identifiers',
    );
    expect(() => createDatabaseRoleSource({ entity: 'r', limit: 100_001 })).toThrow(
      'limit must be',
    );
    expect(() => createDatabaseRoleSource({} as never)).toThrow('entity must be');
  });
});
