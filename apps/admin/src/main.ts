import { erzeugeApi } from "./api.js";
import { rendere } from "./ansicht.js";
import { Steuerung } from "./steuerung.js";

const wurzel = document.getElementById("app");
if (!wurzel) throw new Error("#app fehlt");

const preisFeld = () => wurzel.querySelector<HTMLInputElement>("[data-preis]");
const notizFeld = () => wurzel.querySelector<HTMLInputElement>("[data-notiz]");

const steuerung = new Steuerung(erzeugeApi((url, init) => fetch(url, init)), (z) => {
  // Eine eingetippte Notiz überlebt das Neuzeichnen nicht von selbst.
  const notiz = notizFeld()?.value ?? "";
  const preis = preisFeld()?.value ?? "";
  wurzel.innerHTML = rendere(z);
  const feld = notizFeld();
  if (feld) feld.value = notiz;
  const pf = preisFeld();
  if (pf) pf.value = preis;
});

wurzel.addEventListener("click", (e) => {
  const ziel = e.target as HTMLElement;
  const zeile = ziel.closest<HTMLElement>("tr[data-id]");
  const knopf = ziel.closest<HTMLElement>("[data-aktion]");
  const nav = ziel.closest<HTMLElement>("[data-nav]");
  const bearbeite = ziel.closest<HTMLElement>("[data-bearbeite]");
  const quittiere = ziel.closest<HTMLElement>("[data-quittiere]");
  const erneut = ziel.closest<HTMLElement>("[data-erneut]");
  const seite = ziel.closest<HTMLElement>("[data-seite]");
  if (nav) {
    const w = nav.dataset.nav;
    void (w === "einstellungen" ? steuerung.zeigeEinstellungen() : w === "fehler" ? steuerung.zeigeFehler() : w === "deadletter" ? steuerung.zeigeDeadLetter() : w === "kennzahlen" ? steuerung.zeigeKennzahlen() : steuerung.ladeListe());
  } else if (bearbeite) steuerung.bearbeite(bearbeite.dataset.bearbeite ?? "");
  else if (erneut) void steuerung.reiheErneutEin(Number(erneut.dataset.erneut));
  else if (quittiere) void steuerung.quittiere(Number(quittiere.dataset.quittiere));
  else if (ziel.closest("[data-speichern]")) void steuerung.speichere();
  else if (ziel.closest("[data-zuruecksetzen]")) void steuerung.speichere(true);
  else if (ziel.closest("[data-abbrechen]")) steuerung.brichAb();
  else if (knopf) void steuerung.fuehreAus(knopf.dataset.aktion ?? "", notizFeld()?.value.trim() || undefined, preisFeld()?.value);
  else if (seite) void steuerung.geheZuSeite(Number(seite.dataset.seite));
  else if (ziel.closest("[data-zurueck]")) void steuerung.ladeListe();
  else if (zeile) void steuerung.oeffne(zeile.dataset.id ?? "");
});
wurzel.addEventListener("input", (e) => {
  const ziel = e.target as HTMLElement;
  if (ziel.matches("[data-wert]")) steuerung.tippe((ziel as HTMLTextAreaElement).value);
});
wurzel.addEventListener("change", (e) => {
  const ziel = e.target as HTMLElement;
  if (ziel.matches("[data-zeitraum]")) {
    const wert = (name: string) => wurzel.querySelector<HTMLInputElement>(`[data-zeitraum="${name}"]`)?.value ?? "";
    void steuerung.setzeZeitraum(wert("von"), wert("bis"));
  } else if (ziel.matches("[data-filter]")) void steuerung.setzeFilter((ziel as HTMLSelectElement).value || null);
});

void steuerung.start();
