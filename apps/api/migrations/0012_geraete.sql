-- Phase 7: gekoppelte Geräte der App. Token und Codes liegen nur als Hash vor.
CREATE TABLE geraete (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  erstellt_am   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ablauf_am     TEXT NOT NULL,
  widerrufen_am TEXT,
  push_token    TEXT
);

CREATE TABLE kopplungscodes (
  code_hash     TEXT PRIMARY KEY,
  erstellt_von  TEXT NOT NULL,
  erstellt_am   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ablauf_am     TEXT NOT NULL,
  eingeloest_am TEXT
);
