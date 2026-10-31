import { Hono, type Context } from "hono";
import { AktionSchema, AnhaengenSchema, AnlegenSchema, ListeSchema, detailAnfrage, fuehreAktionAus, haengeAn, legeAn, listeAnfragen, type AnfrageUmgebung } from "../anfragen/index.js";
import { pruefeAnkaufspreis, speichereAnkauf, wertAbweichungAus } from "../auswertung/index.js";
import { managerZugang, type AppUmgebung } from "../env.js";
import { AppFehler } from "../fehler/app-fehler.js";

async function json(req: Request): Promise<unknown> {
  return req.json().catch(() => {
    throw new AppFehler("EINGABE_UNGUELTIG", "Kein gültiges JSON");
  });
}

export const umgebung = (c: Context<AppUmgebung>): AnfrageUmgebung => ({ db: c.env.DB, einstellungen: c.get("einstellungen"), queue: c.env.BEWERTUNG_QUEUE, email: c.env.EMAIL, manager: managerZugang(c.env) });

/** Gemeinsame Handler für Admin- und App-Routen: dieselben Regeln, nur der Kanal im Kontext unterscheidet sich. */
export type HandlerKontext = Context<AppUmgebung>;

export async function listeHandler(c: HandlerKontext) {
  const p = ListeSchema.safeParse(c.req.query());
  if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", undefined, { details: p.error.issues });
  return c.json(await listeAnfragen(umgebung(c), p.data));
}

export async function detailHandler(c: HandlerKontext) {
  return c.json(await detailAnfrage(umgebung(c), c.req.param("id") ?? "", c.env.BERICHTE));
}

export async function aktionHandler(c: HandlerKontext, kanal: "admin" | "app") {
  const roh = await json(c.req.raw);
  const p = AktionSchema.safeParse(roh);
  if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", undefined, { details: p.error.issues });
  const k = { kanal, wer: c.get("admin"), korrelation: c.get("korrelationsId") };
  // Der Abschluss verlangt den tatsächlichen Preis (A11); ohne ihn bleibt der Status unverändert.
  const preis = p.data.aktion === "ankauf_abschliessen" ? pruefeAnkaufspreis((roh as { ankaufspreisEuro?: unknown }).ankaufspreisEuro) : null;
  const id = c.req.param("id") ?? "";
  const r = await fuehreAktionAus(umgebung(c), id, p.data, k, c.env.BERICHTE);
  if (preis !== null) await speichereAnkauf(umgebung(c), id, preis, k.wer);
  return c.json(r);
}

export const anfragenRouten = new Hono<AppUmgebung>()
  .get("/", listeHandler)
  .get("/auswertung/ankaeufe", async (c) => c.json(await wertAbweichungAus(umgebung(c))))
  .get("/:id", detailHandler)
  .post("/:id/aktion", (c) => aktionHandler(c, "admin"))
  .post("/", async (c) => {
    const p = AnlegenSchema.safeParse(await json(c.req.raw));
    if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", undefined, { details: p.error.issues });
    const u: AnfrageUmgebung = { db: c.env.DB, einstellungen: c.get("einstellungen"), queue: c.env.BEWERTUNG_QUEUE, email: c.env.EMAIL, manager: managerZugang(c.env) };
    const r = await legeAn(u, p.data, { kanal: "admin", wer: c.get("admin"), korrelation: c.get("korrelationsId") });
    return c.json(r, 201);
  })
  .post("/:id/nachrichten", async (c) => {
    const roh = await json(c.req.raw);
    const p = AnhaengenSchema.safeParse(roh);
    if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", undefined, { details: p.error.issues });
    const u: AnfrageUmgebung = { db: c.env.DB, einstellungen: c.get("einstellungen"), queue: c.env.BEWERTUNG_QUEUE, email: c.env.EMAIL, manager: managerZugang(c.env) };
    const fahrzeugRoh = (roh as { fahrzeug?: object }).fahrzeug;
    const r = await haengeAn(u, c.req.param("id"), p.data, { kanal: "admin", wer: c.get("admin"), korrelation: c.get("korrelationsId") }, fahrzeugRoh);
    return c.json(r);
  });
