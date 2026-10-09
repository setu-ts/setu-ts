CREATE TABLE setu_inbox (
  id          text    PRIMARY KEY,
  kind        text    NOT NULL,
  consumer    text    NOT NULL,
  topic       text    NOT NULL,
  envelope_id text,
  status      text    NOT NULL,
  attempts    integer NOT NULL,
  updated_at  bigint  NOT NULL,
  last_error  text,
  envelope    text
);
CREATE INDEX setu_inbox_status ON setu_inbox (kind, status, updated_at);
