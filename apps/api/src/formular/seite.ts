import { Hono } from "hono";
import type { FormularFeld } from "@kfz/shared";
import type { AppUmgebung } from "../env.js";

/** Pfade der Kundenseite; alles andere außerhalb von /api gehört dem Admin-Web. */
export function istFormularPfad(pfad: string): boolean {
  return pfad === "/formular" || pfad.startsWith("/formular/");
}

/** Strenge Richtlinie der Seite: nur eigene Dateien und das Turnstile-Skript von Cloudflare. */
export const FORMULAR_CSP =
  "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; " +
  "connect-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (t: string): string => t.replace(/[&<>"']/g, (z) => ESC[z] ?? z);

function feldHtml(f: FormularFeld, t: Record<string, string>, i: number): string {
  const id = `f${i}`;
  const pflicht = f.pflicht ? " required" : "";
  const label = `<label for="${id}">${esc(f.label)}${f.pflicht ? ` <abbr title="${esc(t.pflichtHinweis ?? "")}">*</abbr>` : ""}</label>`;
  const hinweis = f.hinweis ? `<small id="${id}h">${esc(f.hinweis)}</small>` : "";
  const beschr = f.hinweis ? ` aria-describedby="${id}h"` : "";
  const name = `name="${esc(f.name)}" id="${id}"`;
  let eingabe: string;
  switch (f.typ) {
    case "zahl":
      eingabe = `<input type="number" inputmode="numeric" min="0" step="1" ${name}${pflicht}${beschr} data-typ="zahl">`;
      break;
    case "text_lang":
      eingabe = `<textarea rows="4" ${name}${pflicht}${beschr}></textarea>`;
      break;
    case "auswahl":
      eingabe = `<select ${name}${pflicht}${beschr}><option value="">${esc(t.auswahlLeer ?? "")}</option>${(f.optionen ?? [])
        .map((o) => `<option value="${esc(o.wert)}">${esc(o.label)}</option>`)
        .join("")}</select>`;
      break;
    case "ja_nein":
      eingabe = `<select ${name}${pflicht}${beschr} data-typ="ja_nein"><option value="">${esc(t.auswahlLeer ?? "")}</option><option value="ja">${esc(t.jaLabel ?? "")}</option><option value="nein">${esc(t.neinLabel ?? "")}</option></select>`;
      break;
    default:
      eingabe = `<input type="text" ${name}${pflicht}${beschr}>`;
  }
  return `<div class="feld">${label}${eingabe}${hinweis}</div>`;
}

/** Mini-Skript der Seite (unter /formular/formular.js, damit die CSP keine Inline-Skripte braucht). */
const SKRIPT = `(function(){
var f=document.getElementById("formular"),m=document.getElementById("meldung"),k=document.getElementById("senden");
function setze(o,pfad,w){var t=pfad.split(".");for(var i=0;i<t.length-1;i++){o=o[t[i]]=o[t[i]]||{};}o[t[t.length-1]]=w;}
f.addEventListener("submit",function(e){
e.preventDefault();var d={};
Array.prototype.forEach.call(f.elements,function(el){
if(!el.name||el.name==="cf-turnstile-response"||el.value==="")return;
var w=el.value;if(el.dataset.typ==="zahl")w=Number(w);else if(el.dataset.typ==="ja_nein")w=w==="ja";
setze(d,el.name,w);});
var t=f.elements["cf-turnstile-response"];if(t)d.turnstileToken=t.value;
if(f.dataset.botschutz&&!d.turnstileToken){m.textContent=f.dataset.botschutzFehlt;return;}
k.disabled=true;m.textContent=f.dataset.sendet;
fetch("/api/anfragen",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(d)})
.then(function(r){if(!r.ok)throw 0;m.textContent=f.dataset.erfolg;f.reset();})
.catch(function(){m.textContent=f.dataset.fehler;})
.then(function(){k.disabled=false;if(window.turnstile)try{window.turnstile.reset();}catch(x){}});
});})();`;

const STIL = `body{font-family:system-ui,sans-serif;max-width:40rem;margin:0 auto;padding:1rem;line-height:1.4}
.feld{margin:0 0 1rem}label{display:block;font-weight:600;margin-bottom:.25rem}
input,select,textarea,button{font:inherit;width:100%;box-sizing:border-box;padding:.5rem}
small{display:block;color:#555}button{cursor:pointer}#meldung{margin-top:1rem;min-height:1.4em}
.datenschutz{background:#f4f4f4;padding:.75rem;border-radius:.25rem;margin:1.5rem 0}`;

/** Öffentliche Kundenseite. Alle Texte, Felder und der Datenschutzhinweis kommen aus der Registry. */
export const formularSeite = new Hono<AppUmgebung>()
  .get("/formular.js", (c) => c.body(SKRIPT, 200, { "Content-Type": "text/javascript; charset=utf-8" }))
  .get("/formular.css", (c) => c.body(STIL, 200, { "Content-Type": "text/css; charset=utf-8" }))
  .get("/", async (c) => {
    const einst = c.get("einstellungen");
    const t = (await einst.lese("formular.texte")) as Record<string, string>;
    const felder = (await einst.lese("formular.felder")) as FormularFeld[];
    const datenschutz = (await einst.lese("formular.datenschutzhinweis")) as string;
    const siteKey = (await einst.lese("formular.turnstileSiteKey")) as string;
    const x = (k: string): string => esc(t[k] ?? "");
    const html = `<!doctype html>
<html lang="${x("kopfzeileSprache")}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${x("seitenTitel")}</title><link rel="stylesheet" href="/formular/formular.css">${
      siteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ""
    }</head>
<body><main><h1>${x("titel")}</h1><p>${x("einleitung")}</p>
<form id="formular" novalidate data-erfolg="${x("erfolg")}" data-fehler="${x("fehler")}" data-sendet="${x("sendet")}" data-botschutz-fehlt="${x("botSchutzFehlt")}"${siteKey ? ' data-botschutz="1"' : ""}>
${felder.map((f, i) => feldHtml(f, t, i)).join("\n")}
<section class="datenschutz"><h2>${x("datenschutzUeberschrift")}</h2><p id="datenschutz">${esc(datenschutz)}</p></section>
${siteKey ? `<div class="cf-turnstile" data-sitekey="${esc(siteKey)}"></div>` : ""}
<button type="submit" id="senden">${x("senden")}</button><p id="meldung" role="status" aria-live="polite"></p>
</form></main><script src="/formular/formular.js"></script></body></html>`;
    return c.html(html);
  });
