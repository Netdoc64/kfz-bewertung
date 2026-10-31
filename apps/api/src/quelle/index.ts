import type { Einstellungen } from "../einstellungen/dienst.js";
import { AppFehler } from "../fehler/app-fehler.js";
import { MockSuche } from "./mock.js";
import type { Suche } from "./port.js";

/** Wählt den Adapter nach `quelle.mobilede.modus`. */
export async function waehleQuelle(einstellungen: Pick<Einstellungen, "lese">): Promise<Suche> {
  const modus = await einstellungen.lese("quelle.mobilede.modus");
  if (modus === "mock") return new MockSuche();
  // live ist noch nicht gebaut: lieber melden als auf Beispieldaten ausweichen.
  throw new AppFehler("QUELLE_ZUGANG", "Der Live-Zugang zu mobile.de ist noch nicht eingerichtet.", { kontext: { modus } });
}
