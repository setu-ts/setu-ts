CREATE TABLE setu_inbox (
  id          TEXT    PRIMARY KEY,
  kind        TEXT    NOT NULL,
  consumer    TEXT    NOT NULL,
  topic       TEXT    NOT NULL,
  envelopeId  TEXT,
  status      TEXT    NOT NULL,
  attempts    INTEGER NOT NULL,
  updatedAt   INTEGER NOT NULL,
  lastError   TEXT,
  envelope    TEXT
);
CREATE INDEX setu_inbox_status ON setu_inbox (kind, status, updatedAt);
