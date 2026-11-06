import { bigint, boolean, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

// The Drizzle tables behind every entity the example stores on PostgreSQL. The
// columns match `schema.sql`, which `npm run db:setup` applies; the memory
// database needs neither.
const num = (name: string) => bigint(name, { mode: 'number' });

/** The seeded orders the agent looks up. */
export const orders = pgTable('support_orders', {
  id: text('id').primaryKey(),
  customer: text('customer').notNull(),
  item: text('item').notNull(),
  amountCents: integer('amount_cents').notNull(),
});

/** One row per refund the agent issued; the id is the tool call's idempotency key. */
export const refunds = pgTable('support_refunds', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull(),
  amountCents: integer('amount_cents').notNull(),
  reason: text('reason').notNull(),
  runId: text('run_id').notNull(),
  createdAt: num('created_at').notNull(),
});

/** Tier C idempotency records (`createDatabaseIdempotencyStore`). */
export const idempotency = pgTable('setu_idempotency', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  role: text('role').notNull(),
  fingerprint: text('fingerprint').notNull(),
  createdAt: num('created_at').notNull(),
  expiresAt: num('expires_at').notNull(),
  result: text('result'),
});

/** The four agent-run entities (`createDatabaseAgentRunStore`). */
export const agentRuns = pgTable('agent_runs', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  principalId: text('principal_id'),
  definition: text('definition').notNull(),
  version: text('version').notNull(),
  status: text('status').notNull(),
  input: jsonb('input').notNull(),
  leaseOwner: text('lease_owner').notNull(),
  leaseVersion: num('lease_version').notNull(),
  leaseUntil: num('lease_until').notNull(),
  entryCount: integer('entry_count').notNull(),
  approvalIds: jsonb('approval_ids').notNull(),
  chunkCount: integer('chunk_count').notNull(),
  stepChunkStart: integer('step_chunk_start').notNull(),
  cancelRequested: boolean('cancel_requested').notNull(),
  error: text('error'),
  createdAt: num('created_at').notNull(),
  updatedAt: num('updated_at').notNull(),
});
export const agentRunEntries = pgTable('agent_run_entries', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  tenantId: text('tenant_id').notNull(),
  seq: integer('seq').notNull(),
  kind: text('kind').notNull(),
  messages: jsonb('messages').notNull(),
  finishReason: text('finish_reason'),
  usage: jsonb('usage'),
  toolCallId: text('tool_call_id'),
  stepChunkStart: integer('step_chunk_start'),
  leaseVersion: num('lease_version').notNull(),
});
export const agentRunChunks = pgTable('agent_run_chunks', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  tenantId: text('tenant_id').notNull(),
  seq: integer('seq').notNull(),
  chunks: jsonb('chunks').notNull(),
  leaseVersion: num('lease_version').notNull(),
});
export const agentRunApprovals = pgTable('agent_run_approvals', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  tenantId: text('tenant_id').notNull(),
  seq: integer('seq').notNull(),
  toolCallId: text('tool_call_id').notNull(),
  toolName: text('tool_name').notNull(),
  input: jsonb('input'),
  status: text('status').notNull(),
  deadline: num('deadline').notNull(),
  decidedBy: text('decided_by'),
  decidedAt: num('decided_at'),
  reason: text('reason'),
  leaseVersion: num('lease_version').notNull(),
});

/** Entity name → table, for `DatabasePlugin({ type: 'drizzle' })`. */
export const SUPPORT_TABLES = {
  Order: orders,
  Refund: refunds,
  Idempotency: idempotency,
  AgentRun: agentRuns,
  AgentRunEntry: agentRunEntries,
  AgentRunChunks: agentRunChunks,
  AgentRunApproval: agentRunApprovals,
};
