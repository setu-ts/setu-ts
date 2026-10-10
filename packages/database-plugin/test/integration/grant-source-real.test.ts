/**
 * The scoped RBAC grant and role sources against REAL databases (M110b plan
 * §3.16): PostgreSQL through Drizzle, and MongoDB.
 *
 * Guarded with the BDD `ignore` option, never an early `return`, so an unset
 * variable reports the case as ignored rather than as a pass that exercised
 * nothing (the M70c trap). CI sets both: `OUTBOX_POSTGRES_URL` (the bare
 * `POSTGRES_URL` is deliberately unset there — see ci.yml) and `MONGODB_URI`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Pool } from 'npm:pg@^8.0.0';
import { drizzle } from 'npm:drizzle-orm@0.45.2/node-postgres';
import { pgTable, text } from 'npm:drizzle-orm@0.45.2/pg-core';
import { CAPABILITIES } from '@setu-ts/common';
import type { IServiceRegistry, ScopeRef } from '@setu-ts/common';
import {
  createDatabaseGrantSource,
  createDatabaseRoleSource,
  createDrizzleDatabase,
  DatabaseService,
  DrizzleAdapter,
} from '../../src/index.ts';
import type { IDatabaseService } from '../../src/interfaces/index.ts';
import { MongoAdapter } from '../../src/adapters/mongo/mongo-adapter.ts';

const postgresUrl = Deno.env.get('OUTBOX_POSTGRES_URL');
const mongoUrl = Deno.env.get('MONGO_URL') ?? Deno.env.get('MONGODB_URI');
const live = new AbortController().signal;
const T1: ScopeRef = { type: 'tenant', id: 't1' };
const T2: ScopeRef = { type: 'tenant', id: 't2' };

function registry(service: IDatabaseService): IServiceRegistry {
  return {
    get: (token: string) => token === CAPABILITIES.DATABASE ? service : undefined,
  } as unknown as IServiceRegistry;
}

const GRANT_ROWS = [
  { id: 'g1', subject: 'u1', role: 'approver', scopeType: 'tenant', scopeId: 't1' },
  { id: 'g2', subject: 'u1', role: 'viewer', scopeType: null, scopeId: null },
  { id: 'g3', subject: 'u1', role: 'owner', scopeType: 'tenant', scopeId: 't2' },
  { id: 'g4', subject: 'u2', role: 'owner', scopeType: 'tenant', scopeId: 't1' },
  { id: 'g5', subject: 'u1', role: 'trap', scopeType: 'tenant', scopeId: '$where' },
];

const ROLE_ROWS = [
  {
    id: 'r1',
    scopeType: 'tenant',
    scopeId: 't1',
    role: 'regional',
    permission: 'invoices:approve',
  },
  { id: 'r2', scopeType: 'tenant', scopeId: 't1', role: 'regional', permission: 'invoices:read' },
  { id: 'r3', scopeType: 'tenant', scopeId: 't2', role: 'regional', permission: 'invoices:read' },
];

/** The same assertions, against whichever backend `service` runs on. */
async function contract(service: IDatabaseService): Promise<void> {
  const grantRepo = service.getRepository<Record<string, unknown>>('Grant');
  for (const row of GRANT_ROWS) {
    await grantRepo.create(row);
  }
  const roleRepo = service.getRepository<Record<string, unknown>>('Role');
  for (const row of ROLE_ROWS) {
    await roleRepo.create(row);
  }
  const grants = createDatabaseGrantSource({ entity: 'Grant' })(registry(service));
  const roles = createDatabaseRoleSource({ entity: 'Role' })(registry(service));

  const sort = (list: readonly { readonly role: string }[]) =>
    [...list].sort((a, b) => a.role.localeCompare(b.role));

  // A chain question: the subject's grants in the chain, plus global ones.
  expect(sort(await grants.grantsFor({ id: 'u1' }, { kind: 'chain', scopes: [T1] }, live))).toEqual(
    [
      { role: 'approver', scope: T1 },
      { role: 'viewer', scope: null },
    ],
  );
  // Two scopes in the chain.
  expect(sort(await grants.grantsFor({ id: 'u1' }, { kind: 'chain', scopes: [T1, T2] }, live)))
    .toEqual([
      { role: 'approver', scope: T1 },
      { role: 'owner', scope: T2 },
      { role: 'viewer', scope: null },
    ]);
  // Every grant of the subject, and none of another's.
  expect((await grants.grantsFor({ id: 'u1' }, { kind: 'all' }, live)).length).toBe(4);
  expect(await grants.grantsFor({ id: 'nobody' }, { kind: 'all' }, live)).toEqual([]);
  // An operator-looking scope id is a value: it matches only that literal id.
  expect(
    sort(
      await grants.grantsFor({ id: 'u1' }, {
        kind: 'chain',
        scopes: [{ type: 'tenant', id: '$where' }],
      }, live),
    ),
  )
    .toEqual([
      { role: 'trap', scope: { type: 'tenant', id: '$where' } },
      { role: 'viewer', scope: null },
    ]);
  // An operator-looking SUBJECT is a value too.
  expect(await grants.grantsFor({ id: '{"$ne":null}' }, { kind: 'all' }, live)).toEqual([]);

  // Custom roles: one batched query, grouped, scopes kept apart.
  const defined = await roles.rolesFor([T1, T2], live);
  const byScope = (scope: ScopeRef) =>
    defined.find((entry) => entry.scope.id === scope.id && entry.role === 'regional')?.permissions
      .slice()
      .sort();
  expect(byScope(T1)).toEqual(['invoices:approve', 'invoices:read']);
  expect(byScope(T2)).toEqual(['invoices:read']);
}

describe('scoped RBAC database sources on real backends (guarded)', () => {
  it('PostgreSQL through Drizzle', { ignore: postgresUrl === undefined }, async () => {
    const run = crypto.randomUUID().replaceAll('-', '');
    const grantTable = `m110b_grants_${run}`;
    const roleTable = `m110b_roles_${run}`;
    const grant = pgTable(grantTable, {
      id: text('id').primaryKey(),
      subject: text('subject'),
      role: text('role'),
      scopeType: text('scopeType'),
      scopeId: text('scopeId'),
    });
    const role = pgTable(roleTable, {
      id: text('id').primaryKey(),
      scopeType: text('scopeType'),
      scopeId: text('scopeId'),
      role: text('role'),
      permission: text('permission'),
    });
    const pool = new Pool({ connectionString: postgresUrl });
    await pool.query(
      `CREATE TABLE "${grantTable}" (id text primary key, subject text, role text, "scopeType" text, "scopeId" text)`,
    );
    await pool.query(
      `CREATE TABLE "${roleTable}" (id text primary key, "scopeType" text, "scopeId" text, role text, permission text)`,
    );
    const adapter = new DrizzleAdapter({
      drizzleInstance: createDrizzleDatabase(drizzle(pool), (db, work) => db.transaction(work)),
      drizzleTables: { Grant: grant, Role: role },
    });
    await adapter.connect();
    try {
      await contract(
        new DatabaseService(adapter, (entity) => adapter.createDataSource(entity), 'drizzle'),
      );
    } finally {
      await adapter.disconnect();
      await pool.query(`DROP TABLE "${grantTable}"`);
      await pool.query(`DROP TABLE "${roleTable}"`);
      await pool.end();
    }
  });

  it('MongoDB', { ignore: mongoUrl === undefined }, async () => {
    const run = crypto.randomUUID().replaceAll('-', '');
    const adapter = new MongoAdapter({
      url: mongoUrl!,
      database: 'setu_m110b',
      collections: {
        Grant: { collection: `grants_${run}`, primaryKey: 'id' },
        Role: { collection: `roles_${run}`, primaryKey: 'id' },
      },
    });
    await adapter.connect();
    try {
      await contract(
        new DatabaseService(adapter, (entity) => adapter.createDataSource(entity), 'mongodb'),
      );
    } finally {
      await adapter.disconnect();
    }
  });
});
