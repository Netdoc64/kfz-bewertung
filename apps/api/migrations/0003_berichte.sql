-- Berichte (Phase 1): je Anfrage und Bewertungsgeneration genau ein Bericht.
-- Wiederholtes Speichern derselben Generation ändert nichts (UNIQUE + DO NOTHING).
CREATE TABLE berichte (
  id                   TEXT PRIMARY KEY,
  anfrage_id           TEXT NOT NULL REFERENCES anfragen (id),
  generation           INTEGER NOT NULL,
  sprache              TEXT NOT NULL,
  eingabe              TEXT NOT NULL,          -- JSON: Fahrzeug, Stichtag
  vergleiche           TEXT NOT NULL,          -- JSON: Vergleichsliste
  zahlen               TEXT NOT NULL,          -- JSON: Bewertung ohne Vergleichsliste
  einstellungs_abdruck TEXT NOT NULL,          -- Einstellungen.abdruck()
  einstellungs_versionen TEXT NOT NULL,        -- JSON: Schlüssel -> Version
  gueltig_bis          TEXT NOT NULL,          -- ablauf.berichtGueltigTage ab Erstellung
  html_ablage          TEXT NOT NULL CHECK (html_ablage IN ('d1', 'r2')),
  html                 TEXT,                   -- gesetzt bei html_ablage = 'd1'
  r2_schluessel        TEXT,                   -- gesetzt bei html_ablage = 'r2'
  erstellt_am          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (anfrage_id, generation)
);
CREATE INDEX idx_berichte_gueltig ON berichte (gueltig_bis);
