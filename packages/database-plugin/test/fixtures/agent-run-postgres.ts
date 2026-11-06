import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text, bigint, integer, boolean, jsonb } from 'drizzle-orm/pg-core';
import { createDrizzleDatabase, DrizzleAdapter, DatabaseService } from '../../src/index.ts';
import { createNodeRuntimeServices } from '@setu-ts/runtime';

export async function agentRunPostgres(url: string, schema?: string) {
  const namespace = schema ?? `m136_${createNodeRuntimeServices().uuid().replaceAll('-', '')}`;
  if (!/^[a-z0-9_]+$/.test(namespace)) throw new Error('Invalid test namespace.');
  const pool = new Pool({ connectionString: url, options: `-c search_path=${namespace}`, max: 4 });
  if (!schema) {
    await pool.query(`CREATE SCHEMA ${namespace}`);
    await pool.query(
      'CREATE TABLE run (id text PRIMARY KEY, "tenantId" text, "principalId" text, definition text, version text, status text, input jsonb, "leaseOwner" text, "leaseVersion" bigint, "leaseUntil" bigint, "entryCount" integer, "approvalIds" jsonb, "chunkCount" integer, "stepChunkStart" integer, "cancelRequested" boolean, error text, "createdAt" bigint, "updatedAt" bigint)',
    );
    await pool.query(
      'CREATE TABLE entry (id text PRIMARY KEY, "runId" text, "tenantId" text, seq integer, kind text, messages jsonb, "finishReason" text, usage jsonb, "toolCallId" text, "stepChunkStart" integer, "leaseVersion" bigint)',
    );
    await pool.query(
      'CREATE TABLE chunks (id text PRIMARY KEY, "runId" text, "tenantId" text, seq integer, chunks jsonb, "leaseVersion" bigint)',
    );
    await pool.query(
      'CREATE TABLE approval (id text PRIMARY KEY, "runId" text, "tenantId" text, seq integer, "toolCallId" text, "toolName" text, input jsonb, status text, deadline bigint, "decidedBy" text, "decidedAt" bigint, reason text, "leaseVersion" bigint)',
    );
    await pool.query(
      'CREATE TABLE idempotency (id text PRIMARY KEY, kind text, role text, fingerprint text, "createdAt" bigint, "expiresAt" bigint, result text)',
    );
    await pool.query('CREATE TABLE business (id text PRIMARY KEY, name text)');
    await pool.query('CREATE TABLE modelcalls (id text PRIMARY KEY, name text)');
  }
  const num = (name: string) => bigint(name, { mode: 'number' });
  const run = pgTable('run', {
    id: text('id').primaryKey(),
    tenantId: text('tenantId'),
    principalId: text('principalId'),
    definition: text('definition'),
    version: text('version'),
    status: text('status'),
    input: jsonb('input'),
    leaseOwner: text('leaseOwner'),
    leaseVersion: num('leaseVersion'),
    leaseUntil: num('leaseUntil'),
    entryCount: integer('entryCount'),
    approvalIds: jsonb('approvalIds'),
    chunkCount: integer('chunkCount'),
    stepChunkStart: integer('stepChunkStart'),
    cancelRequested: boolean('cancelRequested'),
    error: text('error'),
    createdAt: num('createdAt'),
    updatedAt: num('updatedAt'),
  });
  const entry = pgTable('entry', {
    id: text('id').primaryKey(),
    runId: text('runId'),
    tenantId: text('tenantId'),
    seq: integer('seq'),
    kind: text('kind'),
    messages: jsonb('messages'),
    finishReason: text('finishReason'),
    usage: jsonb('usage'),
    toolCallId: text('toolCallId'),
    stepChunkStart: integer('stepChunkStart'),
    leaseVersion: num('leaseVersion'),
  });
  const chunks = pgTable('chunks', {
    id: text('id').primaryKey(),
    runId: text('runId'),
    tenantId: text('tenantId'),
    seq: integer('seq'),
    chunks: jsonb('chunks'),
    leaseVersion: num('leaseVersion'),
  });
  const approval = pgTable('approval', {
    id: text('id').primaryKey(),
    runId: text('runId'),
    tenantId: text('tenantId'),
    seq: integer('seq'),
    toolCallId: text('toolCallId'),
    toolName: text('toolName'),
    input: jsonb('input'),
    status: text('status'),
    deadline: num('deadline'),
    decidedBy: text('decidedBy'),
    decidedAt: num('decidedAt'),
    reason: text('reason'),
    leaseVersion: num('leaseVersion'),
  });
  const idempotency = pgTable('idempotency', {
    id: text('id').primaryKey(),
    kind: text('kind'),
    role: text('role'),
    fingerprint: text('fingerprint'),
    createdAt: num('createdAt'),
    expiresAt: num('expiresAt'),
    result: text('result'),
  });
  const business = pgTable('business', { id: text('id').primaryKey(), name: text('name') });
  const modelcalls = pgTable('modelcalls', { id: text('id').primaryKey(), name: text('name') });
  const adapter = new DrizzleAdapter({
    drizzleInstance: createDrizzleDatabase(drizzle(pool), (db, work) => db.transaction(work)),
    drizzleTables: {
      AgentRun: run,
      AgentRunEntry: entry,
      AgentRunChunks: chunks,
      AgentRunApproval: approval,
      Idempotency: idempotency,
      Business: business,
      ModelCalls: modelcalls,
    },
  });
  await adapter.connect();
  const database = new DatabaseService(
    adapter,
    (entity) => adapter.createDataSource(entity),
    'drizzle',
  );
  return {
    namespace,
    pool,
    adapter,
    database,
    close: async () => {
      await database.close();
      await pool.end();
    },
    dispose: async () => {
      await pool.query(`DROP SCHEMA ${namespace} CASCADE`);
      await database.close();
      await pool.end();
    },
  };
}
