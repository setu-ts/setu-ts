CREATE TABLE setu_outbox (
  id            text    PRIMARY KEY,
  kind          text    NOT NULL,
  topic         text    NOT NULL,
  envelope      text    NOT NULL,
  options       text    NOT NULL,
  ordering_key  text,
  tenant_id     text,
  traceparent   text,
  position      text    NOT NULL,
  created_at    bigint  NOT NULL,
  status        text    NOT NULL,
  attempts      integer NOT NULL,
  available_at  bigint  NOT NULL,
  claim_version bigint  NOT NULL,
  lease_until   bigint  NOT NULL,
  last_error    text,
  settled_at    bigint,
  sent_by       text
);
CREATE INDEX setu_outbox_relay ON setu_outbox (kind, status, position);
CREATE INDEX setu_outbox_purge ON setu_outbox (kind, status, settled_at);
