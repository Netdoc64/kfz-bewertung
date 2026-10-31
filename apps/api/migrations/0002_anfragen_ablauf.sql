-- Anfrage-Ablauf (Phase 1): Job-Generation (A8), angehängte Nachrichten, geparkte Eingänge (A9).

-- Jede Nachricht des Kunden während der Bewertung erhöht die Generation; Jobs älterer Generation werden verworfen.
ALTER TABLE anfragen ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;

-- Weitere Nachrichten des Kunden an eine bestehende Anfrage.
CREATE TABLE anfrage_nachrichten (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  anfrage_id   TEXT NOT NULL REFERENCES anfragen (id),
  kanal        TEXT NOT NULL,
  text         TEXT NOT NULL,
  generation   INTEGER NOT NULL,             -- Generation, die diese Nachricht ausgelöst hat
  korrelation  TEXT NOT NULL,
  erstellt_am  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_anfrage_nachrichten ON anfrage_nachrichten (anfrage_id, id);

-- Eingänge über dem Flutschutz-Limit: gespeichert, aber keine Anfrage und keine Antwort.
CREATE TABLE eingang_geparkt (
  id           TEXT PRIMARY KEY,
  kontakt      TEXT NOT NULL,
  kanal        TEXT NOT NULL,
  nutzlast     TEXT NOT NULL,                -- JSON der Eingabe
  grund        TEXT NOT NULL,
  korrelation  TEXT NOT NULL,
  erstellt_am  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_eingang_geparkt ON eingang_geparkt (kontakt, erstellt_am);
CREATE INDEX idx_anfragen_kontakt ON anfragen (kunde_kontakt, erstellt_am);
