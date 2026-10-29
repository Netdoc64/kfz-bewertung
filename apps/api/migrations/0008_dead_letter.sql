-- Dead-Letter: endgültig fehlgeschlagene Queue-Jobs, bis ein Mensch sie erneut einreiht.
CREATE TABLE dead_letter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nachricht_id TEXT NOT NULL UNIQUE,
  queue TEXT NOT NULL,
  anfrage_id TEXT,
  job_generation INTEGER,
  korrelation TEXT,
  nutzlast TEXT NOT NULL,
  versuche INTEGER NOT NULL DEFAULT 0,
  erstellt_am TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  erneut_am TEXT,
  erneut_von TEXT,
  erneut_generation INTEGER
);
CREATE INDEX idx_dead_letter_offen ON dead_letter (erneut_am, erstellt_am);
