import type { MiddlewareHandler } from "hono";
import type { EinstellungsSchluessel } from "@kfz/shared";
import type { Einstellungen } from "../einstellungen/dienst.js";
import type { AppUmgebung } from "../env.js";
import { AppFehler } from "../fehler/app-fehler.js";

export type RatenKanal = "formular" | "email" | "app";

const GRENZE: Record<RatenKanal, { max: EinstellungsSchluessel; fenster: EinstellungsSchluessel }> = {
  formular: { max: "ratenlimit.formular.max", fenster: "ratenlimit.formular.fensterSekunden" },
  email: { max: "ratenlimit.email.max", fenster: "ratenlimit.email.fensterSekunden" },
  app: { max: "ratenlimit.app.max", fenster: "ratenlimit.app.fensterSekunden" },
};

async function hash(text: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Zählt einen Zugriff des Absenders im aktuellen Fenster und wirft `RATE_LIMIT_UEBERSCHRITTEN`,
 * sobald die Grenze aus der Registry überschritten ist. Der Absender (IP, Adresse) wird nur gehasht
 * gespeichert und auch im Fehlerkontext nur als gekürzter Hash genannt.
 */
export async function pruefeRatenlimit(db: D1Database, einst: Einstellungen, kanal: RatenKanal, absender: string, jetzt: number = Date.now()): Promise<void> {
  const max = (await einst.lese(GRENZE[kanal].max)) as number;
  const fensterMs = ((await einst.lese(GRENZE[kanal].fenster)) as number) * 1000;
  const start = Math.floor(jetzt / fensterMs) * fensterMs;
  const h = await hash(`${kanal}|${absender.trim().toLowerCase()}`);

  const zeile = await db
    .prepare(
      `INSERT INTO ratenzaehler (kanal, absender_hash, fenster_start, anzahl) VALUES (?1, ?2, ?3, 1)
       ON CONFLICT (kanal, absender_hash, fenster_start) DO UPDATE SET anzahl = anzahl + 1
       RETURNING anzahl`,
    )
    .bind(kanal, h, start)
    .first<{ anzahl: number }>();
  // Alte Fenster dieses Kanals räumen, damit die Tabelle nicht wächst.
  await db.prepare("DELETE FROM ratenzaehler WHERE kanal = ?1 AND fenster_start < ?2").bind(kanal, start).run();

  if ((zeile?.anzahl ?? 0) > max) {
    const warteSekunden = Math.max(1, Math.ceil((start + fensterMs - jetzt) / 1000));
    throw new AppFehler("RATE_LIMIT_UEBERSCHRITTEN", `Ratenbegrenzung ${kanal} überschritten`, { kontext: { kanal, absender: h.slice(0, 12), warteSekunden } });
  }
}

/**
 * Absenderkennung einer HTTP-Anfrage: die von Cloudflare gesetzte Client-IP. Cloudflare setzt sie
 * an der Kante immer; fehlt sie (lokaler Aufruf, Tests), gibt es keinen Absender, den man zählen könnte.
 */
export function absenderAusAnfrage(kopfzeile: (name: string) => string | undefined): string | undefined {
  return kopfzeile("CF-Connecting-IP");
}

/** Middleware: begrenzt alle Aufrufe eines Kanals je Absender; setzt `Retry-After` bei 429. */
export function ratenlimit(kanal: RatenKanal): MiddlewareHandler<AppUmgebung> {
  return async (c, next) => {
    const absender = absenderAusAnfrage((n) => c.req.header(n));
    if (absender === undefined) return next();
    try {
      await pruefeRatenlimit(c.env.DB, c.get("einstellungen"), kanal, absender);
    } catch (e) {
      if (e instanceof AppFehler && e.code === "RATE_LIMIT_UEBERSCHRITTEN") c.header("Retry-After", String(e.kontext?.warteSekunden ?? 1));
      throw e;
    }
    await next();
  };
}
