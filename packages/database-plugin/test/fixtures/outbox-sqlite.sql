CREATE TABLE setu_outbox (
  id          TEXT    PRIMARY KEY,
  kind        TEXT    NOT NULL,
  topic       TEXT    NOT NULL,
  envelope    TEXT    NOT NULL,
  options     TEXT    NOT NULL,
  orderingKey TEXT,
  tenantId    TEXT,
  traceparent TEXT,
  position    TEXT    NOT NULL,
  createdAt   INTEGER NOT NULL,
  status      TEXT    NOT NULL,
  attempts    INTEGER NOT NULL,
  availableAt INTEGER NOT NULL,
  claimVersion INTEGER NOT NULL,
  leaseUntil  INTEGER NOT NULL,
  lastError   TEXT,
  settledAt   INTEGER,
  sentBy      TEXT
);
CREATE INDEX setu_outbox_relay ON setu_outbox (kind, status, position);
CREATE INDEX setu_outbox_purge ON setu_outbox (kind, status, settledAt);
