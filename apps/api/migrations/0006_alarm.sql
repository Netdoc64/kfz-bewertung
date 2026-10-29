-- Ruhezeit je Fehlerfingerabdruck (A4): wann zuletzt alarmiert wurde.
CREATE TABLE alarm_ruhe (
  fingerabdruck TEXT PRIMARY KEY,
  zuletzt_alarmiert TEXT NOT NULL
);
