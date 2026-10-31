import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { wechsle, type AnfrageUmgebung, type Zeile } from "../src/anfragen/dienst.js";
import { Einstellungen } from "../src/einstellungen/dienst.js";
import { AppFehler } from "../src/fehler/app-fehler.js";
import { pushAttrappe, pushFuer } from "../src/push/index.js";
import { app } from "../src/index.js";

const einst = () => new Einstellungen(env.DB, async () => {});
const GOLF = JSON.stringify({ marke: "VW", modell: "Golf" });

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}
async function geraet(id: string, pushToken: string | null, widerrufen = false) {
  await env.DB.prepare("INSERT INTO geraete (id, name, token_hash, ablauf_am, widerrufen_am, push_token) VALUES (?1, ?1, ?1, '2999-01-01T00:00:00.000Z', ?2, ?3)")
    .bind(id, widerrufen ? "2026-01-01T00:00:00.000Z" : null, pushToken)
    .run();
}
function mail(wirft = false) {
  const gesendet: unknown[] = [];
  const email = {
    async send(m: unknown) {
      if (wirft) throw new Error("kaputt");
      gesendet.push(m);
      return { messageId: "x" };
    },
  } as unknown as SendEmail;
  return { email, gesendet };
}
async function wechselNachFreigabe(push: ReturnType<typeof pushAttrappe>, email: SendEmail) {
  await env.DB.prepare("DELETE FROM anfragen").run();
  await env.DB.prepare(
    "INSERT INTO anfragen (id, kanal, status, kunde_name, kunde_kontakt, fahrzeug, generation, dubletten_schluessel) VALUES ('a1', 'admin', 'in_bewertung', 'N', 'a1@example.de', ?1, 1, 'a1')",
  )
    .bind(GOLF)
    .run();
  const u = { db: env.DB, einstellungen: einst(), queue: {} as never, email, push } as AnfrageUmgebung;
  const z = (await env.DB.prepare("SELECT * FROM anfragen WHERE id = 'a1'").first<Zeile>())!;
  await wechsle(u, z, "bewertung_fertig", "system", { kanal: "admin", wer: "system", korrelation: "k1" });
}

beforeEach(async () => {
  for (const t of ["freigabe_benachrichtigungen", "anfrage_ereignisse", "anfragen", "einstellungen", "fehler_ereignisse", "alarm_ruhe", "geraete"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await setze("mail.absenderAdresse", "kfz@example.de");
  await setze("mail.adminEmpfaenger", ["admin@example.de"]);
  await setze("push.aktiv", true);
});

describe("Push bei neuer Freigabe", () => {
  it("genau ein Push je aktivem Gerät, Texte aus der Registry; widerrufene und token-lose Geräte bekommen keinen", async () => {
    await geraet("g1", "tok-1");
    await geraet("g2", "tok-2");
    await geraet("g3", "tok-3", true);
    await geraet("g4", null);
    const push = pushAttrappe();
    const { email, gesendet } = mail();
    await wechselNachFreigabe(push, email);
    expect(gesendet).toHaveLength(1);
    expect(push.gesendet.map((p) => p.geraetePushToken).sort()).toEqual(["tok-1", "tok-2"]);
    expect(push.gesendet[0]).toMatchObject({ titel: "Neue Freigabe", text: "Anfrage a1 (VW Golf) wartet auf Freigabe." });
  });

  it("push.aktiv=false → kein Push, kein Fehler", async () => {
    await setze("push.aktiv", false);
    await geraet("g1", "tok-1");
    const push = pushAttrappe();
    await wechselNachFreigabe(push, mail().email);
    expect(push.gesendet).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM fehler_ereignisse").first<{ n: number }>())!.n).toBe(0);
  });

  it("ohne Schlüssel gibt es keinen Anschluss", () => {
    expect(pushFuer({})).toBeUndefined();
    expect(pushFuer({ PUSH_FCM_PROJEKT: "p" })).toBeUndefined();
  });

  it("Push-Fehler → PUSH_FEHLGESCHLAGEN im Fehlerspeicher, die Mail geht trotzdem raus", async () => {
    await geraet("g1", "tok-1");
    const push = pushAttrappe(new AppFehler("PUSH_FEHLGESCHLAGEN", "FCM down"));
    const { email, gesendet } = mail();
    await wechselNachFreigabe(push, email);
    expect(gesendet).toHaveLength(1);
    const f = await env.DB.prepare("SELECT code FROM fehler_ereignisse WHERE ort = 'benachrichtigung:push'").first<{ code: string }>();
    expect(f!.code).toBe("PUSH_FEHLGESCHLAGEN");
  });

  it("Mail scheitert → kein Push", async () => {
    await geraet("g1", "tok-1");
    const push = pushAttrappe();
    await wechselNachFreigabe(push, mail(true).email);
    expect(push.gesendet).toHaveLength(0);
  });
});

describe("POST /api/app/push-token", () => {
  it("speichert das Token des Geräts; ohne Geräte-Token 401", async () => {
    const post = (body: unknown, kopf: Record<string, string> = {}) =>
      app.request("http://lokal/api/app/push-token", { method: "POST", headers: { "content-type": "application/json", ...kopf }, body: JSON.stringify(body) }, env);
    expect((await post({ token: "x" })).status).toBe(401);

    const code = ((await (await app.request("http://lokal/api/admin/geraete/kopplungscode", { method: "POST" }, env)).json()) as { code: string }).code;
    const k = await app.request(
      "http://lokal/api/app/koppeln",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Handy" }) },
      env,
    );
    const { geraetId, token } = (await k.json()) as { geraetId: string; token: string };
    expect((await post({}, { authorization: `Bearer ${token}` })).status).toBe(400);
    expect((await post({ token: "fcm-123" }, { authorization: `Bearer ${token}` })).status).toBe(200);
    expect((await env.DB.prepare("SELECT push_token FROM geraete WHERE id = ?1").bind(geraetId).first<{ push_token: string }>())!.push_token).toBe("fcm-123");
  });
});
