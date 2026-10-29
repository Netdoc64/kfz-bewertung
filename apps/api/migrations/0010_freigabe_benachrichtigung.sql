-- A3: je Anfrage, Generation und Stufe (neu, erinnerung, eskalation) genau eine Benachrichtigung.
CREATE TABLE freigabe_benachrichtigungen (
  anfrage_id  TEXT NOT NULL,
  generation  INTEGER NOT NULL,
  stufe       TEXT NOT NULL CHECK (stufe IN ('neu', 'erinnerung', 'eskalation')),
  gesendet_am TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (anfrage_id, generation, stufe)
);
