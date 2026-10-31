-- Phase 6: Nutzung des KI-Anschlusses je Aufruf (Grundlage für Tagesbudget und Kosten).
CREATE TABLE ki_nutzung (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  anfrage_id  TEXT,
  faehigkeit  TEXT NOT NULL,
  modell      TEXT NOT NULL,
  token_ein   INTEGER NOT NULL DEFAULT 0,
  token_aus   INTEGER NOT NULL DEFAULT 0,
  kosten_euro REAL NOT NULL DEFAULT 0,
  am          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_ki_nutzung_am ON ki_nutzung (am);
CREATE INDEX idx_ki_nutzung_anfrage ON ki_nutzung (anfrage_id);
