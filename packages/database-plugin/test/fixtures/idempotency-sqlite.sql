CREATE TABLE setu_idempotency (
  id          TEXT    PRIMARY KEY,
  kind        TEXT    NOT NULL,
  role        TEXT    NOT NULL,
  fingerprint TEXT    NOT NULL,
  createdAt   INTEGER NOT NULL,
  expiresAt   INTEGER NOT NULL,
  result      TEXT
);
CREATE INDEX setu_idempotency_expiry ON setu_idempotency (kind, role, expiresAt);
