CREATE TABLE setu_idempotency (
  id          text   PRIMARY KEY,
  kind        text   NOT NULL,
  role        text   NOT NULL,
  fingerprint text   NOT NULL,
  created_at  bigint NOT NULL,
  expires_at  bigint NOT NULL,
  result      text
);
CREATE INDEX setu_idempotency_expiry ON setu_idempotency (kind, role, expires_at);
