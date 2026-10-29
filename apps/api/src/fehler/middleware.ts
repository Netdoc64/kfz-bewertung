import { EINSTELLUNGEN, type FehlerAntwort } from "@kfz/shared";
import type { Context, ErrorHandler, MiddlewareHandler, NotFoundHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { Einstellungen } from "../einstellungen/dienst.js";
import type { AppUmgebung } from "../env.js";
import { AppFehler, alsAppFehler } from "./app-fehler.js";
import { fehlerSpeichern } from "./speicher.js";

export const KORRELATIONS_HEADER = "X-Korrelations-Id";
const GUELTIGE_ID = /^[A-Za-z0-9._-]{8,64}$/;

function ort(c: Context): string {
  return `${c.req.method} ${c.req.routePath ?? c.req.path}`;
}

/** Korrelations-ID übernehmen oder vergeben, Einstellungen je Anfrage anlegen. */
export const grundlage: MiddlewareHandler<AppUmgebung> = async (c, next) => {
  const eingehend = c.req.header(KORRELATIONS_HEADER);
  const id = eingehend && GUELTIGE_ID.test(eingehend) ? eingehend : crypto.randomUUID();
  c.set("korrelationsId", id);
  c.header(KORRELATIONS_HEADER, id);

  // Meldungen aus dem Einstellungsdienst nutzen den Standard-Schwellwert,
  // damit ein kaputter Schwellwert nicht sich selbst meldet.
  const schwelle = EINSTELLUNGEN["betrieb.fehlerSpeichernAbSchwere"].standard;
  c.set(
    "einstellungen",
    new Einstellungen(c.env.DB, (f) => fehlerSpeichern(c.env.DB, { fehler: f, ort: ort(c), korrelationsId: id }, schwelle)),
  );
  await next();
};

export const fehlerBehandlung: ErrorHandler<AppUmgebung> = async (e, c) => {
  const f = alsAppFehler(e);
  const korrelationsId = c.get("korrelationsId") ?? crypto.randomUUID();

  let schwelle = EINSTELLUNGEN["betrieb.fehlerSpeichernAbSchwere"].standard;
  try {
    schwelle = await c.get("einstellungen").lese("betrieb.fehlerSpeichernAbSchwere");
  } catch {
    // DB weg — Standard nutzen.
  }
  const speichern = fehlerSpeichern(c.env.DB, { fehler: f, ort: ort(c), korrelationsId }, schwelle);
  try {
    c.executionCtx.waitUntil(speichern);
  } catch {
    await speichern; // ohne ExecutionContext (Tests)
  }

  const def = f.definition;
  const body: FehlerAntwort = {
    fehler: {
      code: f.code,
      // Interne Nachrichten nie nach außen: bei 5xx immer der Katalogtext.
      text: def.status >= 500 ? def.text : f.message,
      korrelationsId,
      wiederholbar: def.wiederholbar,
      ...(f.details !== undefined ? { details: f.details } : {}),
    },
  };
  c.header(KORRELATIONS_HEADER, korrelationsId);
  return c.json(body, def.status as ContentfulStatusCode);
};

export const nichtGefunden: NotFoundHandler<AppUmgebung> = (c) => fehlerBehandlung(new AppFehler("NICHT_GEFUNDEN", `Kein Endpunkt ${c.req.method} ${c.req.path}`), c);
