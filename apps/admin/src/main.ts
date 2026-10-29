import { erzeugeApi } from "./api.js";
import { rendere } from "./ansicht.js";
import { Steuerung } from "./steuerung.js";

const wurzel = document.getElementById("app");
if (!wurzel) throw new Error("#app fehlt");

const notizFeld = () => wurzel.querySelector<HTMLInputElement>("[data-notiz]");

const steuerung = new Steuerung(erzeugeApi((url, init) => fetch(url, init)), (z) => {
  // Eine eingetippte Notiz überlebt das Neuzeichnen nicht von selbst.
  const notiz = notizFeld()?.value ?? "";
  wurzel.innerHTML = rendere(z);
  const feld = notizFeld();
  if (feld) feld.value = notiz;
});

wurzel.addEventListener("click", (e) => {
  const ziel = e.target as HTMLElement;
  const zeile = ziel.closest<HTMLElement>("tr[data-id]");
  const knopf = ziel.closest<HTMLElement>("[data-aktion]");
  const seite = ziel.closest<HTMLElement>("[data-seite]");
  if (knopf) void steuerung.fuehreAus(knopf.dataset.aktion ?? "", notizFeld()?.value.trim() || undefined);
  else if (seite) void steuerung.geheZuSeite(Number(seite.dataset.seite));
  else if (ziel.closest("[data-zurueck]")) void steuerung.ladeListe();
  else if (zeile) void steuerung.oeffne(zeile.dataset.id ?? "");
});
wurzel.addEventListener("change", (e) => {
  const ziel = e.target as HTMLElement;
  if (ziel.matches("[data-filter]")) void steuerung.setzeFilter((ziel as HTMLSelectElement).value || null);
});

void steuerung.start();
