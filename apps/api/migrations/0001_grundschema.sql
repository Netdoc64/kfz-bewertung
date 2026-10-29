-- Grundschema Phase 0

-- Einstellungen: überschreiben die Standardwerte der Registry.
CREATE TABLE einstellungen (
  schluessel   TEXT PRIMARY KEY,
  wert         TEXT,                       -- JSON, NULL = Standardwert der Registry
  version      INTEGER NOT NULL DEFAULT 1, -- steigt monoton, auch beim Zurücksetzen
  geaendert_am TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  geaendert_von TEXT NOT NULL
);

CREATE TABLE einstellungen_verlauf (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  schluessel   TEXT NOT NULL,
  version      INTEGER NOT NULL,
  wert_vorher  TEXT,                       -- JSON, NULL = Standardwert
  wert_nachher TEXT,                       -- JSON, NULL = auf Standard zurückgesetzt
  geaendert_am TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  geaendert_von TEXT NOT NULL
);
CREATE INDEX idx_einstellungen_verlauf_schluessel ON einstellungen_verlauf (schluessel, version);

-- Zentrales Fehlersystem: gleiche Fehler werden über den Fingerabdruck gezählt.
CREATE TABLE fehler_ereignisse (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerabdruck    TEXT NOT NULL UNIQUE,
  code             TEXT NOT NULL,
  schwere          TEXT NOT NULL,
  ort              TEXT NOT NULL,          -- z. B. "GET /api/einstellungen" oder "queue:bewertung"
  nachricht        TEXT NOT NULL,
  kontext          TEXT,                   -- JSON, geschwärzt
  letzte_korrelation TEXT NOT NULL,
  anzahl           INTEGER NOT NULL DEFAULT 1,
  erstmals         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  zuletzt          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  quittiert_am     TEXT,
  quittiert_von    TEXT
);
CREATE INDEX idx_fehler_offen ON fehler_ereignisse (quittiert_am, zuletzt);

-- Anfragen (Felder für Phase 1 vorbereitet).
CREATE TABLE anfragen (
  id             TEXT PRIMARY KEY,
  kanal          TEXT NOT NULL CHECK (kanal IN ('formular', 'email', 'whatsapp', 'admin', 'app')),
  status         TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  kunde_name     TEXT,
  kunde_kontakt  TEXT,                     -- Telefon oder E-Mail; DSGVO-Löschfrist beachten
  sprache        TEXT,
  fahrzeug       TEXT NOT NULL,            -- JSON (FahrzeugSchema)
  dubletten_schluessel TEXT,
  rueckfragen    INTEGER NOT NULL DEFAULT 0,
  erstellt_am    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  geaendert_am   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_anfragen_status ON anfragen (status, geaendert_am);
CREATE INDEX idx_anfragen_dublette ON anfragen (dubletten_schluessel, erstellt_am);

-- Jeder Statuswechsel, nachvollziehbar.
CREATE TABLE anfrage_ereignisse (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  anfrage_id   TEXT NOT NULL REFERENCES anfragen (id),
  aktion       TEXT NOT NULL,
  status_von   TEXT,
  status_nach  TEXT NOT NULL,
  durch        TEXT NOT NULL,              -- "system" oder Admin-Kennung
  notiz        TEXT,
  korrelation  TEXT NOT NULL,
  am           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_anfrage_ereignisse ON anfrage_ereignisse (anfrage_id, id);

-- Idempotenz: Queue-Nachrichten kommen mindestens einmal.
CREATE TABLE verarbeitete_jobs (
  job_id       TEXT PRIMARY KEY,
  art          TEXT NOT NULL,
  am           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
