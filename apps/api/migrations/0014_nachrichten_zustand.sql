-- Zustand, mit dem der Manager den Versand quittiert hat (gesendet, eingereiht); NULL bei Kanälen ohne Quittung und bei älteren Zeilen.
ALTER TABLE nachrichten ADD COLUMN zustand TEXT;
