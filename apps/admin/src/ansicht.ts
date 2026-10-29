import type { Aktion, Anfrage, Detail } from "./api.js";
import type { Zustand } from "./steuerung.js";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

const datum = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" }).format(d);
};

type T = (schluessel: string) => string;
const beschrifter = (z: Zustand): T => (k) => z.beschriftungen[k] ?? k;

function meldung(z: Zustand, t: T): string {
  const m = z.meldung;
  if (!m) return "";
  const kennung = m.korrelationsId ? ` <code>${esc(m.korrelationsId)}</code>` : "";
  const titel = m.art === "fehler" ? `<strong>${esc(t("fehler"))}${m.code ? ` ${esc(m.code)}` : ""}:</strong> ` : "";
  return `<div class="meldung ${m.art}" role="alert">${titel}${esc(m.text)}${kennung}</div>`;
}

function filterLeiste(z: Zustand, t: T): string {
  const optionen = Object.entries(z.statusNamen)
    .map(([k, name]) => `<option value="${esc(k)}"${z.filter === k ? " selected" : ""}>${esc(name)}</option>`)
    .join("");
  return `<label>${esc(t("filter"))} <select data-filter><option value="">${esc(t("alle"))}</option>${optionen}</select></label>`;
}

function fahrzeugText(a: Anfrage): string {
  return [a.fahrzeug.marke, a.fahrzeug.modell].filter(Boolean).join(" ");
}

export function rendereListe(z: Zustand): string {
  const t = beschrifter(z);
  const l = z.liste;
  let inhalt = "";
  if (l) {
    const seiten = Math.max(1, Math.ceil(l.gesamt / l.proSeite));
    const zeilen = l.eintraege
      .map(
        (a) =>
          `<tr data-id="${esc(a.id)}" tabindex="0"><td>${esc(a.kunde_name ?? a.kunde_kontakt ?? "")}</td><td>${esc(fahrzeugText(a))}</td>` +
          `<td><span class="status status-${esc(a.status)}">${esc(a.statusText)}</span></td><td>${esc(datum(a.geaendert_am))}</td></tr>`,
      )
      .join("");
    inhalt = l.eintraege.length
      ? `<table><thead><tr><th>${esc(t("kunde"))}</th><th>${esc(t("fahrzeug"))}</th><th>${esc(t("status"))}</th><th>${esc(t("geaendert"))}</th></tr></thead><tbody>${zeilen}</tbody></table>`
      : `<p>${esc(t("leer"))}</p>`;
    inhalt +=
      `<nav class="seiten"><button data-seite="${l.seite - 1}"${l.seite <= 1 ? " disabled" : ""}>${esc(t("zurueckSeite"))}</button> ` +
      `${esc(t("seite"))} ${l.seite} ${esc(t("von"))} ${seiten} ` +
      `<button data-seite="${l.seite + 1}"${l.seite >= seiten ? " disabled" : ""}>${esc(t("vor"))}</button></nav>`;
  } else if (z.laedt) inhalt = `<p>${esc(t("laedt"))}</p>`;
  return `<h1>${esc(t("titel"))}</h1>${meldung(z, t)}${filterLeiste(z, t)}${inhalt}`;
}

function aktionsLeiste(d: Detail, t: T, gesperrt: boolean): string {
  if (!d.aktionen.length) return `<p>${esc(t("keineAktionen"))}</p>`;
  const text = (a: Aktion) => (a.name && t(`aktion.${a.name}`) !== `aktion.${a.name}` ? t(`aktion.${a.name}`) : a.nachText);
  const knopf = (a: Aktion) => `<button data-aktion="${esc(a.name)}"${gesperrt ? " disabled" : ""}>${esc(text(a))}</button>`;
  return `<label>${esc(t("notiz"))} <input data-notiz maxlength="1000"></label> ${d.aktionen.map(knopf).join(" ")}`;
}

export function rendereDetail(z: Zustand): string {
  const t = beschrifter(z);
  const d = z.detail;
  const kopf = `<button data-zurueck>${esc(t("zurueck"))}</button>${meldung(z, t)}`;
  if (!d) return kopf + (z.laedt ? `<p>${esc(t("laedt"))}</p>` : "");
  const a = d.anfrage;
  const ereignisse = d.ereignisse
    .map((e) => `<li>${esc(datum(e.am))} — ${esc(e.statusNachText)} (${esc(e.durch)})${e.notiz ? `: ${esc(e.notiz)}` : ""}</li>`)
    .join("");
  const ausgehend = d.nachrichten.map((n) => `<li>${esc(datum(n.erstellt_am))} — ${esc(n.anlass)} · ${esc(n.status)}<pre>${esc(n.inhalt)}</pre></li>`).join("");
  const eingehend = d.kundenNachrichten.map((n) => `<li>${esc(datum(n.erstellt_am))}<pre>${esc(n.text)}</pre></li>`).join("");
  // Der Bericht ist serverseitig erzeugtes HTML; er läuft in einer Sandbox ohne Skripte.
  const bericht = d.bericht
    ? `<iframe sandbox title="${esc(t("bericht"))}" srcdoc="${esc(d.bericht.html)}"></iframe>`
    : `<p>${esc(t("keinBericht"))}</p>`;
  return (
    `${kopf}<h1>${esc(a.kunde_name ?? a.kunde_kontakt ?? a.id)} · ${esc(fahrzeugText(a))}</h1>` +
    `<p><span class="status status-${esc(a.status)}">${esc(a.statusText)}</span></p>` +
    `<section><h2>${esc(t("aktionen"))}</h2>${aktionsLeiste(d, t, z.laedt)}</section>` +
    `<section><h2>${esc(t("bericht"))}</h2>${bericht}</section>` +
    `<section><h2>${esc(t("ereignisse"))}</h2><ul>${ereignisse}</ul></section>` +
    `<section><h2>${esc(t("nachrichten"))}</h2><ul>${ausgehend}</ul></section>` +
    `<section><h2>${esc(t("kundenNachrichten"))}</h2><ul>${eingehend}</ul></section>`
  );
}

export const rendere = (z: Zustand): string => (z.ansicht === "liste" ? rendereListe(z) : rendereDetail(z));
