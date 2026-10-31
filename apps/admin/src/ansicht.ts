import type { Aktion, Anfrage, Dauer, Detail, Kennzahlen } from "./api.js";
import type { Bearbeitung, Zustand } from "./steuerung.js";

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

function kiBlock(k: Kennzahlen["ki"], t: T): string {
  const zeilen = Object.entries(k.faehigkeiten)
    .map(([f, n]) => `<tr><td>${esc(f)}</td><td>${esc(zahl(n.aufrufe))}</td><td>${esc(zahl(n.tokenEin))}</td><td>${esc(zahl(n.tokenAus))}</td><td>${esc(kiEuro(n.kostenEuro))}</td></tr>`)
    .join("");
  const kopf = `<th>${esc(t("kennzahlKiFaehigkeit"))}</th><th>${esc(t("kennzahlKiAufrufe"))}</th><th>${esc(t("kennzahlKiTokenEin"))}</th><th>${esc(t("kennzahlKiTokenAus"))}</th><th>${esc(t("kennzahlKiKosten"))}</th>`;
  const summe = `<p>${esc(t("kennzahlKiAufrufe"))}: ${esc(zahl(k.aufrufe))}, ${esc(t("kennzahlKiTokenEin"))}: ${esc(zahl(k.tokenEin))}, ${esc(t("kennzahlKiTokenAus"))}: ${esc(zahl(k.tokenAus))}, ${esc(t("kennzahlKiKosten"))}: ${esc(kiEuro(k.kostenEuro))}, ${esc(t("kennzahlKiKostenJeAnfrage"))}: ${esc(kiEuro(k.kostenJeAnfrage))}</p>`;
  return `<section><h2>${esc(t("kennzahlKi"))}</h2>${k.aufrufe ? `${summe}<table><thead><tr>${kopf}</tr></thead><tbody>${zeilen}</tbody></table>` : `<p>${esc(t("kennzahlKiLeer"))}</p>`}</section>`;
}

function meldung(z: Zustand, t: T): string {
  const m = z.meldung;
  if (!m) return "";
  const kennung = m.korrelationsId ? ` <code>${esc(m.korrelationsId)}</code>` : "";
  const titel = m.art === "fehler" ? `<strong>${esc(t("fehler"))}${m.code ? ` ${esc(m.code)}` : ""}:</strong> ` : "";
  return `<div class="meldung ${m.art}" role="alert">${titel}${esc(m.text)}${kennung}</div>`;
}

function navigation(z: Zustand, t: T): string {
  const knopf = (ziel: string, text: string, aktiv: boolean) =>
    `<button data-nav="${ziel}"${aktiv ? ' disabled aria-current="page"' : ""}>${esc(text)}</button>`;
  const anfragen = z.ansicht === "liste";
  if (z.appModus) return `<nav class="haupt">${knopf("anfragen", t("navAnfragen"), anfragen)}</nav>`;
  return `<nav class="haupt">${knopf("anfragen", t("navAnfragen"), anfragen)} ${knopf("einstellungen", t("navEinstellungen"), z.ansicht === "einstellungen")} ${knopf("fehler", t("navFehler"), z.ansicht === "fehler")} ${knopf("deadletter", t("navDeadLetter"), z.ansicht === "deadletter")} ${knopf("kennzahlen", t("navKennzahlen"), z.ansicht === "kennzahlen")}</nav>`;
}

function filterLeiste(z: Zustand, t: T): string {
  if (!Object.keys(z.statusNamen).length) return "";
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
  return `${navigation(z, t)}<h1>${esc(t("titel"))}</h1>${meldung(z, t)}${filterLeiste(z, t)}${inhalt}`;
}

function aktionsLeiste(d: Detail, t: T, gesperrt: boolean): string {
  if (!d.aktionen.length) return `<p>${esc(t("keineAktionen"))}</p>`;
  const text = (a: Aktion) => (a.name && t(`aktion.${a.name}`) !== `aktion.${a.name}` ? t(`aktion.${a.name}`) : a.nachText);
  const knopf = (a: Aktion) => `<button data-aktion="${esc(a.name)}"${gesperrt ? " disabled" : ""}>${esc(text(a))}</button>`;
  // Der Ankauf verlangt den tatsächlichen Preis (A11); die API lehnt ihn ohne gültigen Betrag ab.
  const preis = d.aktionen.some((a) => a.name === "ankauf_abschliessen")
    ? `<label>${esc(t("ankaufspreis"))} <input data-preis inputmode="decimal" autocomplete="off"></label> `
    : "";
  return `<label>${esc(t("notiz"))} <input data-notiz maxlength="1000"></label> ${preis}${d.aktionen.map(knopf).join(" ")}`;
}

export function rendereDetail(z: Zustand): string {
  const t = beschrifter(z);
  const d = z.detail;
  const kopf = `${navigation(z, t)}<button data-zurueck>${esc(t("zurueck"))}</button>${meldung(z, t)}`;
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

const wertText = (w: unknown) => JSON.stringify(w) ?? "";

const euro = (w: number | null) => (w === null ? "–" : new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(w));

function vorschauBlock(b: Bearbeitung, t: T): string {
  const v = b.vorschau?.ergebnis;
  if (!v) return "";
  const zeilen = v.zeilen
    .map((z) => {
      const grund = (x: string[]) => (x.length ? x.join(", ") : "–");
      return (
        `<tr class="${z.geaendert ? "geaendert" : "gleich"}"><td><code>${esc(z.anfrageId)}</code></td>` +
        `<td>${esc(euro(z.vorher.ankaufspreisEuro))}</td><td>${esc(euro(z.nachher.ankaufspreisEuro))}</td>` +
        `<td>${z.ankaufDifferenzEuro === null ? "–" : esc(euro(z.ankaufDifferenzEuro))}</td>` +
        `<td>${esc(grund(z.vorher.anMenschGruende))} → ${esc(grund(z.nachher.anMenschGruende))}</td></tr>`
      );
    })
    .join("");
  return (
    `<div class="vorschau"><h3>${esc(t("vorschauTitel"))}</h3>` +
    `<p>${esc(v.geaendert)} ${esc(t("vorschauVon"))} ${esc(v.anzahl)} ${esc(t("vorschauGeaendert"))}</p>` +
    `<table><thead><tr><th>${esc(t("vorschauAnfrage"))}</th><th>${esc(t("vorschauVorher"))}</th><th>${esc(t("vorschauNachher"))}</th><th>${esc(t("vorschauDifferenz"))}</th><th>${esc(t("vorschauMensch"))}</th></tr></thead><tbody>${zeilen}</tbody></table>` +
    `<p>${esc(t("vorschauHinweis"))}</p></div>`
  );
}

function bearbeitungsFeld(z: Zustand, t: T): string {
  const b = z.bearbeitung;
  const e = z.einstellungen?.find((x) => x.schluessel === b?.schluessel);
  if (!b || !e) return "";
  const warnung = b.warnungen.length
    ? `<div class="meldung konflikt" role="alert">${esc(t("plausibilitaet"))}<ul>${b.warnungen.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>`
    : "";
  const sperre = z.laedt ? " disabled" : "";
  return (
    `<section class="bearbeitung"><h2>${esc(e.schluessel)}</h2><p>${esc(e.beschreibung)}</p>${warnung}` +
    `<label>${esc(t("wert"))}<textarea data-wert rows="12" cols="80">${esc(b.text)}</textarea></label>` +
    `<p>${esc(t("standardwert"))}: <code>${esc(wertText(e.standard))}</code></p>${vorschauBlock(b, t)}` +
    `<button data-speichern${sperre}>${esc(b.vorschau ? t("speichernNachVorschau") : b.warnungen.length ? t("trotzdemSpeichern") : t("vorschauZeigen"))}</button> ` +
    `<button data-zuruecksetzen${sperre}>${esc(t("zuruecksetzen"))}</button> <button data-abbrechen>${esc(t("abbrechen"))}</button></section>`
  );
}

export function rendereEinstellungen(z: Zustand): string {
  const t = beschrifter(z);
  let inhalt = z.laedt && !z.einstellungen ? `<p>${esc(t("laedt"))}</p>` : "";
  if (z.einstellungen) {
    const zeilen = z.einstellungen
      .map(
        (e) =>
          `<tr><td>${esc(e.gruppe)}</td><td>${esc(e.schluessel)}</td><td><code>${esc(wertText(e.wert).slice(0, 80))}</code></td><td>${esc(e.version)}</td>` +
          `<td><button data-bearbeite="${esc(e.schluessel)}">${esc(t("bearbeiten"))}</button></td></tr>`,
      )
      .join("");
    inhalt = `<table><thead><tr><th>${esc(t("gruppe"))}</th><th>${esc(t("einstellungenTitel"))}</th><th>${esc(t("wert"))}</th><th>#</th><th></th></tr></thead><tbody>${zeilen}</tbody></table>`;
  }
  return `${navigation(z, t)}<h1>${esc(t("einstellungenTitel"))}</h1>${meldung(z, t)}${bearbeitungsFeld(z, t)}${inhalt}`;
}

export function rendereFehler(z: Zustand): string {
  const t = beschrifter(z);
  let inhalt = z.laedt && !z.fehlerListe ? `<p>${esc(t("laedt"))}</p>` : "";
  if (z.fehlerListe) {
    const zeilen = z.fehlerListe
      .map(
        (f) =>
          `<tr><td>${esc(f.schwere)}</td><td>${esc(f.code)}</td><td>${esc(f.ort)}</td><td>${esc(f.nachricht)}</td><td>${esc(f.anzahl)}</td><td>${esc(datum(f.zuletzt))}</td>` +
          `<td><code>${esc(f.letzteKorrelation)}</code></td><td><button data-quittiere="${esc(f.id)}"${z.laedt ? " disabled" : ""}>${esc(t("quittieren"))}</button></td></tr>`,
      )
      .join("");
    inhalt = z.fehlerListe.length
      ? `<table><thead><tr><th>${esc(t("fehlerSchwere"))}</th><th>${esc(t("fehlerCode"))}</th><th>${esc(t("fehlerOrt"))}</th><th>${esc(t("fehler"))}</th><th>${esc(t("fehlerAnzahl"))}</th><th>${esc(t("fehlerZuletzt"))}</th><th></th><th></th></tr></thead><tbody>${zeilen}</tbody></table>`
      : `<p>${esc(t("keineFehler"))}</p>`;
  }
  return `${navigation(z, t)}<h1>${esc(t("fehlerTitel"))}</h1>${meldung(z, t)}${inhalt}`;
}

export function rendereDeadLetter(z: Zustand): string {
  const t = beschrifter(z);
  let inhalt = z.laedt && !z.deadLetter ? `<p>${esc(t("laedt"))}</p>` : "";
  if (z.deadLetter) {
    const zeilen = z.deadLetter
      .map(
        (e) =>
          `<tr><td>${esc(datum(e.erstellt_am))}</td><td>${esc(e.queue)}</td><td><code>${esc(e.anfrage_id ?? "")}</code></td><td>${esc(e.versuche)}</td>` +
          `<td><code>${esc(e.korrelation ?? "")}</code></td><td><button data-erneut="${esc(e.id)}"${z.laedt ? " disabled" : ""}>${esc(t("erneutEinreihen"))}</button></td></tr>`,
      )
      .join("");
    inhalt = z.deadLetter.length
      ? `<table><thead><tr><th>${esc(t("deadLetterSeit"))}</th><th>${esc(t("deadLetterQueue"))}</th><th>${esc(t("vorschauAnfrage"))}</th><th>${esc(t("deadLetterVersuche"))}</th><th>${esc(t("deadLetterKorrelation"))}</th><th></th></tr></thead><tbody>${zeilen}</tbody></table>`
      : `<p>${esc(t("keineDeadLetter"))}</p>`;
  }
  return `${navigation(z, t)}<h1>${esc(t("deadLetterTitel"))}</h1>${meldung(z, t)}${inhalt}`;
}

const prozent = (w: number | null) => (w === null ? "–" : new Intl.NumberFormat("de-DE", { style: "percent", maximumFractionDigits: 1 }).format(w));
const zahl = (w: number | null) => (w === null ? "–" : new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(w));
const kiEuro = (w: number | null) => (w === null ? "–" : new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(w));
const stunden = (sek: number | null, t: T) => (sek === null ? "–" : `${zahl(sek / 3600)} ${t("einheitStunden")}`);
const dauerZellen = (d: Dauer | undefined, t: T) =>
  `<td>${esc(d?.anzahl ?? 0)}</td><td>${esc(stunden(d?.mittel ?? null, t))}</td><td>${esc(stunden(d?.median ?? null, t))}</td><td>${esc(stunden(d?.max ?? null, t))}</td>`;

function abweichungsBlock(z: Zustand, t: T): string {
  const a = z.abweichungen;
  if (!a) return "";
  const zeilen = a.zeilen
    .map(
      (x) =>
        `<tr><td>${esc(x.marke)}</td><td>${esc(x.segment)}</td><td>${esc(x.anzahl)}</td><td>${esc(euro(x.abweichungEuro))}</td><td>${esc(zahl(x.abweichungProzent))} %</td><td>${x.belastbar ? "" : esc(t("abweichungUnbelastbar"))}</td></tr>`,
    )
    .join("");
  const tabelle = a.zeilen.length
    ? `<table><thead><tr><th>${esc(t("abweichungMarke"))}</th><th>${esc(t("abweichungSegment"))}</th><th>${esc(t("kennzahlAnzahl"))}</th><th>${esc(t("abweichungEuro"))}</th><th>${esc(t("abweichungProzent"))}</th><th></th></tr></thead><tbody>${zeilen}</tbody></table>`
    : `<p>${esc(t("abweichungLeer"))}</p>`;
  return `<section><h2>${esc(t("abweichungTitel"))}</h2><p>${esc(a.gesamt)} ${esc(t("abweichungAnkaeufe"))}, ${esc(a.ohneSchaetzung)} ${esc(t("abweichungOhneSchaetzung"))}</p>${tabelle}</section>`;
}

export function rendereKennzahlen(z: Zustand): string {
  const t = beschrifter(z);
  const k = z.kennzahlen;
  const wahl =
    `<p><label>${esc(t("zeitraumVon"))} <input type="date" data-zeitraum="von" value="${esc(z.zeitraum.von)}"></label> ` +
    `<label>${esc(t("zeitraumBis"))} <input type="date" data-zeitraum="bis" value="${esc(z.zeitraum.bis)}"></label></p>`;
  let inhalt = z.laedt && !k ? `<p>${esc(t("laedt"))}</p>` : "";
  if (k) {
    const kopfDauer = `<th>${esc(t("kennzahlAnzahl"))}</th><th>${esc(t("kennzahlMittel"))}</th><th>${esc(t("kennzahlMedian"))}</th><th>${esc(t("kennzahlMax"))}</th>`;
    const verweil = Object.entries(k.durchlaufzeit)
      .filter((e): e is [string, Dauer] => typeof e[1] === "object")
      .map(([status, d]) => `<tr><td>${esc(z.statusNamen[status] ?? status)}</td>${dauerZellen(d, t)}</tr>`)
      .join("");
    const gruende = Object.entries(k.anMensch.gruende)
      .map(([g, n]) => `<li>${esc(g)}: ${esc(n)}</li>`)
      .join("");
    const klassen = k.konfidenz.klassen
      .map((c) => `<tr><td>${esc(c.von === null ? `< ${zahl(c.bis)}` : c.bis === null ? `≥ ${zahl(c.von)}` : `${zahl(c.von)}–${zahl(c.bis)}`)}</td><td>${esc(c.anzahl)}</td></tr>`)
      .join("");
    inhalt =
      `<p>${esc(t("kennzahlAnfragen"))}: ${esc(k.anfragen)}</p>` +
      `<section><h2>${esc(t("kennzahlDurchlauf"))}</h2><table><thead><tr><th>${esc(t("status"))}</th>${kopfDauer}</tr></thead><tbody>${verweil}</tbody></table><p>${esc(t("kennzahlOffen"))}: ${esc(k.durchlaufzeit.offen ?? 0)}</p></section>` +
      `<section><h2>${esc(t("kennzahlAnMensch"))}</h2><p>${esc(k.anMensch.anzahl)} (${esc(prozent(k.anMensch.anteil))}), ${esc(t("kennzahlMitGrund"))}: ${esc(prozent(k.anMensch.anteilMitGrund))}</p><ul>${gruende}</ul></section>` +
      `<section><h2>${esc(t("kennzahlKonfidenz"))}</h2><p>${esc(t("kennzahlMittel"))}: ${esc(zahl(k.konfidenz.mittel))} (${esc(k.konfidenz.berichte)})</p><table><tbody>${klassen}</tbody></table></section>` +
      `<section><h2>${esc(t("kennzahlFehlerrate"))}</h2><p>${esc(k.fehlerrate.fehlgeschlagen)} / ${esc(k.fehlerrate.bewertungen)} (${esc(prozent(k.fehlerrate.rate))})</p></section>` +
      `<section><h2>${esc(t("kennzahlFreigabedauer"))}</h2><table><thead><tr>${kopfDauer}</tr></thead><tbody><tr>${dauerZellen(k.freigabedauer, t)}</tr></tbody></table></section>` +
      kiBlock(k.ki, t) +
      abweichungsBlock(z, t);
  }
  return `${navigation(z, t)}<h1>${esc(t("kennzahlenTitel"))}</h1>${meldung(z, t)}${wahl}${inhalt}`;
}

/** Kopplungsansicht des App-Modus: API-Adresse, Kopplungscode und Gerätename. */
export function rendereKopplung(t: T, fehler: { code: string; text: string } | null, laedt: boolean, adresse = ""): string {
  const meldung = fehler ? `<div class="meldung fehler" role="alert"><strong>${esc(t("fehler"))} ${esc(fehler.code)}:</strong> ${esc(fehler.text)}</div>` : "";
  return (
    `<h1>${esc(t("kopplungTitel"))}</h1>${meldung}` +
    `<form data-koppeln><p><label>${esc(t("kopplungAdresse"))} <input name="adresse" inputmode="url" autocomplete="off" value="${esc(adresse)}"></label></p>` +
    `<p><label>${esc(t("kopplungCode"))} <input name="code" autocomplete="off"></label></p>` +
    `<p><label>${esc(t("kopplungName"))} <input name="name" maxlength="80" autocomplete="off"></label></p>` +
    `<button type="submit"${laedt ? " disabled" : ""}>${esc(laedt ? t("laedt") : t("kopplungKnopf"))}</button></form>`
  );
}

export const rendere = (z: Zustand): string =>
  z.ansicht === "liste" ? rendereListe(z) : z.ansicht === "detail" ? rendereDetail(z) : z.ansicht === "einstellungen" ? rendereEinstellungen(z) : z.ansicht === "deadletter" ? rendereDeadLetter(z) : z.ansicht === "kennzahlen" ? rendereKennzahlen(z) : rendereFehler(z);
