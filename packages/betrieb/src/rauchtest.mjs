// Rauchtest nach dem Deploy: ruft <url>/api/gesund und <url>/api/gesundheit ab.
// Technische Prüfung ohne fachliche Werte; Aufruf: npm run rauchtest -- <url>

/** Technische Voreinstellung; per Umgebungsvariable RAUCHTEST_ZEITLIMIT_MS überschreibbar. */
const ZEITLIMIT_MS = 10_000;

/**
 * @typedef {{ stufe: "fehler" | "warnung" | "ok", text: string }} Befund
 * @typedef {{ fetch?: typeof fetch, zeitlimitMs?: number }} Optionen
 */

async function holen(basis, pfad, hf, zeitlimitMs) {
  const steuer = new AbortController();
  const uhr = setTimeout(() => steuer.abort(), zeitlimitMs);
  try {
    const antwort = await hf(`${basis}${pfad}`, { signal: steuer.signal, headers: { accept: "application/json" } });
    let json;
    try {
      json = await antwort.json();
    } catch {
      return { fehler: `${pfad}: Antwort ist kein JSON (Status ${antwort.status})` };
    }
    return { status: antwort.status, json };
  } catch (e) {
    return {
      fehler: steuer.signal.aborted
        ? `${pfad}: Zeitüberschreitung nach ${zeitlimitMs} ms`
        : `${pfad}: nicht erreichbar (${e instanceof Error ? e.message : String(e)})`,
    };
  } finally {
    clearTimeout(uhr);
  }
}

const istObjekt = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * @param {string | undefined} url Basis-URL des Deploys
 * @param {Optionen} [optionen]
 * @returns {Promise<{ ok: boolean, befunde: Befund[] }>}
 */
export async function rauchtest(url, optionen = {}) {
  /** @type {Befund[]} */
  const befunde = [];
  const fehler = (text) => befunde.push({ stufe: "fehler", text });
  const gut = (text) => befunde.push({ stufe: "ok", text });
  if (!url || !/^https?:\/\/[^/\s]+/i.test(url)) {
    fehler("URL fehlt oder ist ungültig (erwartet: https://host)");
    return { ok: false, befunde };
  }
  const basis = url.replace(/\/+$/, "");
  const hf = optionen.fetch ?? fetch;
  const limit = optionen.zeitlimitMs ?? ZEITLIMIT_MS;

  const [gesund, einfach] = await Promise.all([
    holen(basis, "/api/gesund", hf, limit),
    holen(basis, "/api/gesundheit", hf, limit),
  ]);

  if (einfach.fehler) fehler(einfach.fehler);
  else if (einfach.status !== 200 || !istObjekt(einfach.json) || einfach.json.ok !== true) {
    fehler(`/api/gesundheit: Status ${einfach.status}`);
  } else gut("/api/gesundheit ok");

  if (gesund.fehler) {
    fehler(gesund.fehler);
  } else if (gesund.status !== 200 || !istObjekt(gesund.json)) {
    const f = istObjekt(gesund.json) && istObjekt(gesund.json.fehler) ? ` (${String(gesund.json.fehler.code)})` : "";
    fehler(`/api/gesund: Status ${gesund.status}${f}`);
  } else {
    const g = gesund.json;
    if (g.d1 === "ok") gut("D1 ok");
    else fehler(`D1 nicht ok (${String(g.d1)})`);
    if (g.queue === "bereit") gut("Queue bereit");
    else fehler(`Queue nicht bereit (${String(g.queue)})`);
    const abdruck = istObjekt(g.einstellungen) ? g.einstellungen.abdruck : undefined;
    if (typeof abdruck === "string" && abdruck.length > 0) gut(`Einstellungs-Abdruck ${abdruck}`);
    else fehler("Einstellungs-Abdruck fehlt");
    if (typeof g.autopilot === "boolean") gut(`Autopilot ${g.autopilot ? "an" : "aus"}`);
    else fehler("Autopilot-Zustand nicht gemeldet");
    if (typeof g.quelleModus === "string" && g.quelleModus) {
      if (g.umgebung === "produktion" && g.quelleModus === "mock") {
        fehler("Produktion läuft mit quelle.mobilede.modus=mock (Beispieldaten)");
      } else gut(`Quelle-Modus ${g.quelleModus}`);
    } else fehler("Quelle-Modus nicht gemeldet");
    if (g.ok !== true) fehler("/api/gesund meldet ok=false");
  }
  return { ok: !befunde.some((b) => b.stufe === "fehler"), befunde };
}
