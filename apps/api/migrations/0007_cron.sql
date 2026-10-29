-- Laufprotokoll der Cron-Aufgaben: jeder Lauf, auch abgeschaltete, übersprungene und fehlgeschlagene.
CREATE TABLE cron_laeufe (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  aufgabe      TEXT NOT NULL,
  korrelation  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('ok', 'aus', 'uebersprungen', 'fehler')),
  bearbeitet   INTEGER NOT NULL DEFAULT 0,
  notiz        TEXT,
  fehler_code  TEXT,
  beginn       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ende         TEXT
);
CREATE INDEX idx_cron_laeufe ON cron_laeufe (aufgabe, id);

-- Berichtsablauf: einmal als abgelaufen markiert, danach ein No-op.
ALTER TABLE berichte ADD COLUMN abgelaufen_am TEXT;
-- DSGVO-Löschung: Zeitpunkt, an dem die Personendaten einer Anfrage entfernt wurden.
ALTER TABLE anfragen ADD COLUMN personendaten_geloescht_am TEXT;
