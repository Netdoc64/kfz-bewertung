-- Admin-Prüfung geparkter Eingänge: Geprüft-Kennzeichen und Entscheidung.
ALTER TABLE eingang_geparkt ADD COLUMN geprueft_am TEXT;
ALTER TABLE eingang_geparkt ADD COLUMN geprueft_von TEXT;
ALTER TABLE eingang_geparkt ADD COLUMN entscheidung TEXT CHECK (entscheidung IN ('freigegeben', 'verworfen'));
ALTER TABLE eingang_geparkt ADD COLUMN anfrage_id TEXT;
CREATE INDEX idx_eingang_geparkt_offen ON eingang_geparkt (entscheidung, erstellt_am);
