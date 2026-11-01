-- Phase 8: Zähler der Ratenbegrenzung. Der Absender liegt nur als Hash vor (kein Klartext, keine IP).
CREATE TABLE ratenzaehler (
  kanal         TEXT NOT NULL,
  absender_hash TEXT NOT NULL,
  fenster_start INTEGER NOT NULL,
  anzahl        INTEGER NOT NULL,
  PRIMARY KEY (kanal, absender_hash, fenster_start)
);
CREATE INDEX ratenzaehler_fenster ON ratenzaehler (fenster_start);
