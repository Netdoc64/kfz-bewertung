import {
  EINSTELLUNGEN,
  EINSTELLUNGS_SCHLUESSEL,
  type EinstellungsGruppe,
  type EinstellungsSchluessel,
  type EinstellungsWert,
} from "@kfz/shared";
import { AppFehler } from "../fehler/app-fehler.js";

export type Quelle = "standard" | "gespeichert" | "standard_ersatz";

export interface Eintrag<K extends EinstellungsSchluessel = EinstellungsSchluessel> {
  schluessel: K;
  wert: EinstellungsWert<K>;
  standard: EinstellungsWert<K>;
  /** 0 = nie gespeichert. */
  version: number;
  /** standard_ersatz = gespeicherter Wert war ungültig, Standard greift. */
  quelle: Quelle;
  gruppe: EinstellungsGruppe;
  beschreibung: string;
  geaendertAm: string | null;
  geaendertVon: string | null;
}

interface Zeile {
  schluessel: string;
  wert: string | null;
  version: number;
  geaendert_am: string;
  geaendert_von: string;
}

type Melder = (f: AppFehler) => Promise<void>;

/**
 * Liest und schreibt Laufzeiteinstellungen. Ein Exemplar je Anfrage bzw. Job:
 * innerhalb davon ist jeder Wert stabil (Cache), damit eine Bewertung nicht
 * mitten im Lauf mit zwei verschiedenen Ständen rechnet.
 */
export class Einstellungen {
  private cache = new Map<string, Eintrag>();
  private allesGeladen = false;

  constructor(
    private readonly db: D1Database,
    private readonly melden: Melder,
  ) {}

  async lese<K extends EinstellungsSchluessel>(k: K): Promise<EinstellungsWert<K>> {
    return (await this.eintrag(k)).wert;
  }

  async eintrag<K extends EinstellungsSchluessel>(k: K): Promise<Eintrag<K>> {
    const c = this.cache.get(k);
    if (c) return c as Eintrag<K>;
    const zeile = await this.db.prepare("SELECT * FROM einstellungen WHERE schluessel = ?1").bind(k).first<Zeile>();
    const e = await this.auswerten(k, zeile);
    this.cache.set(k, e);
    return e;
  }

  async alle(): Promise<Eintrag[]> {
    if (!this.allesGeladen) {
      const { results } = await this.db.prepare("SELECT * FROM einstellungen").all<Zeile>();
      const nachSchluessel = new Map(results.map((z) => [z.schluessel, z]));
      for (const k of EINSTELLUNGS_SCHLUESSEL) {
        if (!this.cache.has(k)) this.cache.set(k, await this.auswerten(k, nachSchluessel.get(k) ?? null));
      }
      this.allesGeladen = true;
    }
    return EINSTELLUNGS_SCHLUESSEL.map((k) => this.cache.get(k)!);
  }

  /**
   * Setzt einen Wert (oder `null` = zurück auf Standard). `erwarteteVersion`
   * ist die Version, die der Aufrufer gesehen hat — sonst VERSION_KONFLIKT.
   */
  async setze<K extends EinstellungsSchluessel>(k: K, wert: unknown, erwarteteVersion: number, von: string): Promise<Eintrag<K>> {
    const def = EINSTELLUNGEN[k];
    let json: string | null = null;
    if (wert !== null) {
      const p = def.schema.safeParse(wert);
      if (!p.success) {
        throw new AppFehler("EINGABE_UNGUELTIG", `Ungültiger Wert für ${k}`, { details: p.error.issues });
      }
      json = JSON.stringify(p.data);
    }

    const vorher = await this.db.prepare("SELECT * FROM einstellungen WHERE schluessel = ?1").bind(k).first<Zeile>();
    const istVersion = vorher?.version ?? 0;
    if (istVersion !== erwarteteVersion) {
      throw new AppFehler("VERSION_KONFLIKT", undefined, { details: { erwartet: erwarteteVersion, aktuell: istVersion } });
    }

    const neu = erwarteteVersion + 1;
    const schreiben = vorher
      ? this.db
          .prepare(
            `UPDATE einstellungen SET wert = ?2, version = ?3, geaendert_von = ?4,
               geaendert_am = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE schluessel = ?1 AND version = ?5`,
          )
          .bind(k, json, neu, von, erwarteteVersion)
      : this.db
          .prepare("INSERT INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (schluessel) DO NOTHING")
          .bind(k, json, neu, von);

    const r = await schreiben.run();
    if (r.meta.changes !== 1) {
      throw new AppFehler("VERSION_KONFLIKT", undefined, { details: { erwartet: erwarteteVersion } });
    }
    await this.db
      .prepare("INSERT INTO einstellungen_verlauf (schluessel, version, wert_vorher, wert_nachher, geaendert_von) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(k, neu, vorher?.wert ?? null, json, von)
      .run();

    this.cache.delete(k);
    this.allesGeladen = false;
    return this.eintrag(k);
  }

  async verlauf(k: EinstellungsSchluessel, grenze: number) {
    const { results } = await this.db
      .prepare("SELECT version, wert_vorher, wert_nachher, geaendert_am, geaendert_von FROM einstellungen_verlauf WHERE schluessel = ?1 ORDER BY version DESC LIMIT ?2")
      .bind(k, grenze)
      .all<{ version: number; wert_vorher: string | null; wert_nachher: string | null; geaendert_am: string; geaendert_von: string }>();
    return results.map((z) => ({
      version: z.version,
      wertVorher: z.wert_vorher === null ? null : JSON.parse(z.wert_vorher),
      wertNachher: z.wert_nachher === null ? null : JSON.parse(z.wert_nachher),
      geaendertAm: z.geaendert_am,
      geaendertVon: z.geaendert_von,
    }));
  }

  /**
   * Abdruck aller wirksamen Werte. Jeder Bericht speichert ihn, damit eine
   * Bewertung später mit genau diesem Stand nachvollzogen werden kann.
   */
  async abdruck(): Promise<{ abdruck: string; versionen: Record<string, number> }> {
    const alle = await this.alle();
    const versionen = Object.fromEntries(alle.map((e) => [e.schluessel, e.version]));
    const text = JSON.stringify(alle.map((e) => [e.schluessel, e.wert]));
    const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const abdruck = [...new Uint8Array(h)]
      .slice(0, 6)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return { abdruck, versionen };
  }

  private async auswerten<K extends EinstellungsSchluessel>(k: K, zeile: Zeile | null): Promise<Eintrag<K>> {
    const def = EINSTELLUNGEN[k];
    const basis = {
      schluessel: k,
      standard: def.standard as EinstellungsWert<K>,
      gruppe: def.gruppe,
      beschreibung: def.beschreibung,
      version: zeile?.version ?? 0,
      geaendertAm: zeile?.geaendert_am ?? null,
      geaendertVon: zeile?.geaendert_von ?? null,
    };
    if (!zeile || zeile.wert === null) return { ...basis, wert: basis.standard, quelle: "standard" };

    let roh: unknown;
    try {
      roh = JSON.parse(zeile.wert);
    } catch {
      roh = Symbol("kein JSON");
    }
    const p = def.schema.safeParse(roh);
    if (p.success) return { ...basis, wert: p.data as EinstellungsWert<K>, quelle: "gespeichert" };

    // Nie abstürzen: Standard nehmen und laut melden.
    await this.melden(
      new AppFehler("EINSTELLUNG_UNGUELTIG", `Gespeicherter Wert für ${k} ist ungültig, Standard greift`, {
        kontext: { schluessel: k, version: zeile.version, probleme: p.success ? [] : p.error.issues.slice(0, 5) },
      }),
    );
    return { ...basis, wert: basis.standard, quelle: "standard_ersatz" };
  }
}
