-- PostgreSQL schema for the durable agent example. `npm run db:setup` applies
-- it, and it is safe to run again: every statement is IF NOT EXISTS or
-- ON CONFLICT DO NOTHING. The memory database needs none of it.

CREATE TABLE IF NOT EXISTS support_orders (
  id             text    PRIMARY KEY,
  owner_id       text    NOT NULL,
  customer       text    NOT NULL,
  item           text    NOT NULL,
  amount_cents   integer NOT NULL
);
CREATE INDEX IF NOT EXISTS support_orders_owner ON support_orders (owner_id);

-- The id is the order id and the refund's number on it (A-1001#1, A-1001#2):
-- two refunds racing on one order try the same key, so the second fails
-- instead of both passing the "not more than is left" check.
CREATE TABLE IF NOT EXISTS support_refunds (
  id           text    PRIMARY KEY,
  order_id     text    NOT NULL,
  amount_cents integer NOT NULL,
  reason       text    NOT NULL,
  run_id       text    NOT NULL,
  call_key     text    NOT NULL,
  created_at   bigint  NOT NULL
);
CREATE INDEX IF NOT EXISTS support_refunds_order ON support_refunds (order_id);

CREATE TABLE IF NOT EXISTS setu_idempotency (
  id          text   PRIMARY KEY,
  kind        text   NOT NULL,
  role        text   NOT NULL,
  fingerprint text   NOT NULL,
  created_at  bigint NOT NULL,
  expires_at  bigint NOT NULL,
  result      text
);
CREATE INDEX IF NOT EXISTS setu_idempotency_expiry ON setu_idempotency (kind, role, expires_at);

CREATE TABLE IF NOT EXISTS agent_runs (
  id               text    PRIMARY KEY,
  tenant_id        text    NOT NULL,
  principal_id     text,
  definition       text    NOT NULL,
  version          text    NOT NULL,
  status           text    NOT NULL,
  input            jsonb   NOT NULL,
  lease_owner      text    NOT NULL,
  lease_version    bigint  NOT NULL,
  lease_until      bigint  NOT NULL,
  entry_count      integer NOT NULL,
  approval_ids     jsonb   NOT NULL,
  chunk_count      integer NOT NULL,
  step_chunk_start integer NOT NULL,
  cancel_requested boolean NOT NULL,
  error            text,
  created_at       bigint  NOT NULL,
  updated_at       bigint  NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_runs_status ON agent_runs (status, lease_until, updated_at);

CREATE TABLE IF NOT EXISTS agent_run_entries (
  id               text    PRIMARY KEY,
  run_id           text    NOT NULL,
  tenant_id        text    NOT NULL,
  seq              integer NOT NULL,
  kind             text    NOT NULL,
  messages         jsonb   NOT NULL,
  finish_reason    text,
  usage            jsonb,
  tool_call_id     text,
  step_chunk_start integer,
  lease_version    bigint  NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_run_entries_run ON agent_run_entries (run_id, seq);

CREATE TABLE IF NOT EXISTS agent_run_chunks (
  id            text    PRIMARY KEY,
  run_id        text    NOT NULL,
  tenant_id     text    NOT NULL,
  seq           integer NOT NULL,
  chunks        jsonb   NOT NULL,
  lease_version bigint  NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_run_chunks_run ON agent_run_chunks (run_id, seq);

CREATE TABLE IF NOT EXISTS agent_run_approvals (
  id            text    PRIMARY KEY,
  run_id        text    NOT NULL,
  tenant_id     text    NOT NULL,
  seq           integer NOT NULL,
  tool_call_id  text    NOT NULL,
  tool_name     text    NOT NULL,
  input         jsonb,
  status        text    NOT NULL,
  deadline      bigint  NOT NULL,
  decided_by    text,
  decided_at    bigint,
  reason        text,
  lease_version bigint  NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_run_approvals_status ON agent_run_approvals (status, deadline);
CREATE INDEX IF NOT EXISTS agent_run_approvals_run ON agent_run_approvals (run_id, seq);

INSERT INTO support_orders (id, owner_id, customer, item, amount_cents) VALUES
  ('A-1001', 'priya', 'Priya Natarajan', 'Noise-cancelling headphones', 18900),
  ('A-1002', 'tomas', 'Tomás Ferreira', 'Mechanical keyboard', 12450),
  ('A-1003', 'amara', 'Amara Okafor', 'USB-C dock', 8999)
ON CONFLICT (id) DO NOTHING;
