-- WhatsApp-Eingang (Phase 4): verarbeitete Nachrichten des Managers. Die Nachrichten-ID ist der
-- Wiederholschutz: dieselbe ID wird kein zweites Mal verarbeitet. Bilder liegen in email_anhaenge.
CREATE TABLE whatsapp_eingang (
  nachricht_id TEXT PRIMARY KEY,
  anfrage_id   TEXT REFERENCES anfragen (id),
  geparkt_id   TEXT REFERENCES eingang_geparkt (id),
  erstellt_am  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_whatsapp_eingang_anfrage ON whatsapp_eingang (anfrage_id);
