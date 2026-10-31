/** Port für Push-Nachrichten an ein Gerät. Fehler werden als `AppFehler` mit Code PUSH_FEHLGESCHLAGEN geworfen. */
export interface PushAnschluss {
  sende(geraetePushToken: string, titel: string, text: string): Promise<void>;
}
