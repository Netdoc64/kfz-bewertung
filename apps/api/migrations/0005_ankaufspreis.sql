-- Tatsächlicher Ankaufspreis (A11): je Anfrage genau ein Eintrag, beim Abschluss erfasst.
-- Die Schätzung wird als Momentaufnahme mitgespeichert, damit spätere Berichte sie nicht verändern.
CREATE TABLE ankaeufe (
  anfrage_id      TEXT PRIMARY KEY REFERENCES anfragen (id),
  marke           TEXT NOT NULL,
  preis_euro      REAL NOT NULL CHECK (preis_euro >= 0),
  geschaetzt_euro REAL,                        -- ankaufspreisEuro aus dem letzten Bericht, NULL ohne Bericht
  erfasst_von     TEXT NOT NULL,
  erfasst_am      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_ankaeufe_marke ON ankaeufe (marke);
