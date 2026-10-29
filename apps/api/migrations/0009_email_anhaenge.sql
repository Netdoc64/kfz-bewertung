-- E-Mail-Eingang (Phase 3): verarbeitete Mails (Idempotenz bei erneuter Zustellung,
-- Antwort-Zuordnung über Message-ID) und Anhänge im R2-Bucket BERICHTE.
CREATE TABLE email_eingang (
  message_id   TEXT PRIMARY KEY,                -- ohne spitze Klammern
  anfrage_id   TEXT REFERENCES anfragen (id),
  geparkt_id   TEXT REFERENCES eingang_geparkt (id),
  erstellt_am  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_email_eingang_anfrage ON email_eingang (anfrage_id);

CREATE TABLE email_anhaenge (
  id           TEXT PRIMARY KEY,
  anfrage_id   TEXT REFERENCES anfragen (id),
  geparkt_id   TEXT REFERENCES eingang_geparkt (id),   -- bis ein Mensch die Mail freigibt
  r2_schluessel TEXT NOT NULL UNIQUE,
  dateiname    TEXT,
  medientyp    TEXT NOT NULL,
  groesse      INTEGER NOT NULL,
  erstellt_am  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (anfrage_id IS NOT NULL OR geparkt_id IS NOT NULL)
);
CREATE INDEX idx_email_anhaenge_anfrage ON email_anhaenge (anfrage_id);
CREATE INDEX idx_email_anhaenge_geparkt ON email_anhaenge (geparkt_id);
