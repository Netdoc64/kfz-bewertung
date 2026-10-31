-- Versand (Phase 1-3): jede ausgehende Nachricht, auch geparkte und fehlgeschlagene.
-- Der Einstellungsabdruck hält fest, mit welchem Stand Text und Entscheidung entstanden.
CREATE TABLE nachrichten (
  id                   TEXT PRIMARY KEY,
  anfrage_id           TEXT REFERENCES anfragen (id),
  kontakt              TEXT NOT NULL,
  kanal                TEXT NOT NULL,
  anlass               TEXT NOT NULL,
  vorlage              TEXT NOT NULL,
  sprache              TEXT NOT NULL,
  inhalt               TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('gesendet', 'geparkt', 'fehlgeschlagen')),
  datenschutz_angehaengt INTEGER NOT NULL DEFAULT 0,
  autopilot            TEXT NOT NULL,          -- Stand von ablauf.autopilot beim Versuch
  einstellungs_abdruck TEXT NOT NULL,
  korrelation          TEXT NOT NULL,
  externe_id           TEXT,
  fehler_code          TEXT,
  schluessel           TEXT UNIQUE,            -- optional: Idempotenz je Anlass und Anfrage
  erstellt_am          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_nachrichten_anfrage ON nachrichten (anfrage_id, erstellt_am);
CREATE INDEX idx_nachrichten_kontakt ON nachrichten (kontakt, status);
