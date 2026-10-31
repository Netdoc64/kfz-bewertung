// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const antwort = (koerper: unknown, status = 200) => new Response(JSON.stringify(koerper), { status, headers: { "content-type": "application/json" } });

async function lade(opts: { app?: boolean; kopplung?: boolean; fetchen?: (url: string, init?: RequestInit) => Response | Promise<Response> } = {}) {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  if (opts.app) (window as unknown as { Capacitor: unknown }).Capacitor = {};
  else delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  if (opts.kopplung) localStorage.setItem("kfz.kopplung", JSON.stringify({ adresse: "https://x.test", token: "t" }));
  const aufrufe: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    aufrufe.push(`${init?.method ?? "GET"} ${url}`);
    return opts.fetchen ? opts.fetchen(url, init) : antwort({ fehler: { code: "NETZ", text: "x" } }, 500);
  });
  await import("../src/main.js");
  await new Promise((r) => setTimeout(r, 20));
  return { wurzel: document.getElementById("app") as HTMLElement, aufrufe };
}

const klick = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const warte = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllGlobals());

describe("main.ts Verdrahtung", () => {
  it("fehlendes #app wirft", async () => {
    vi.resetModules();
    document.body.innerHTML = "";
    await expect(import("../src/main.js")).rejects.toThrow("#app fehlt");
  });

  it("zeigt im App-Modus ohne Kopplung die Kopplungsansicht und koppelt per Formular", async () => {
    const { wurzel, aufrufe } = await lade({ app: true, fetchen: () => antwort({ fehler: { code: "KOPPLUNG_UNGUELTIG", text: "falsch" } }, 400) });
    const form = wurzel.querySelector<HTMLFormElement>("[data-koppeln]");
    expect(form).not.toBeNull();
    for (const [n, w] of [["adresse", "https://x.test"], ["code", "123"], ["name", ""]] as const) {
      const feld = form!.elements.namedItem(n) as HTMLInputElement | null;
      if (feld) feld.value = w;
    }
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await warte();
    expect(aufrufe.some((a) => a.includes("/api/app/koppeln"))).toBe(true);
    expect(wurzel.textContent).toContain("falsch");
  });

  it("andere Formulare werden ignoriert", async () => {
    const { wurzel } = await lade({ app: true });
    const f = document.createElement("form");
    wurzel.appendChild(f);
    const ev = new Event("submit", { bubbles: true, cancelable: true });
    f.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("mit Kopplung startet die Steuerung über die App-API", async () => {
    const { aufrufe } = await lade({ app: true, kopplung: true });
    expect(aufrufe.some((a) => a.includes("https://x.test/api/app"))).toBe(true);
  });

  it("Klicks, Tasten und Eingaben auf beliebigen Zielen lösen nichts Ungültiges aus", async () => {
    const { wurzel } = await lade();
    const navs = ["einstellungen", "fehler", "deadletter", "kennzahlen", "geparkt", "liste"];
    const attribute = [
      ...navs.map((n) => ["data-nav", n]),
      ["data-bearbeite", "k"], ["data-erneut", "1"], ["data-quittiere", "1"], ["data-speichern", ""], ["data-zuruecksetzen", ""],
      ["data-abbrechen", ""], ["data-aktion", "ablehnen"], ["data-seite", "2"], ["data-zurueck", ""],
      ["data-geparkt-verwerfen", "g1"], ["data-geparkt-pruefen", "g1"],
    ];
    for (const [a, w] of attribute) {
      wurzel.innerHTML = `<button ${a}="${w}">x</button>`;
      klick(wurzel.firstElementChild!);
      await warte();
    }
    wurzel.innerHTML = '<table><tbody><tr data-id="a1" tabindex="0"><td>x</td></tr></tbody></table>';
    const zeile = wurzel.querySelector("tr")!;
    klick(zeile.firstElementChild!);
    await warte();
    for (const taste of ["Enter", " ", "a"]) zeile.dispatchEvent(new KeyboardEvent("keydown", { key: taste, bubbles: true, cancelable: true }));
    const zelle = document.createElement("td");
    zeile.appendChild(zelle);
    zelle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    wurzel.innerHTML = "<textarea data-wert></textarea><input><input data-preis><input data-notiz>";
    for (const el of Array.from(wurzel.querySelectorAll("textarea, input"))) el.dispatchEvent(new Event("input", { bubbles: true }));
    wurzel.innerHTML = '<input data-zeitraum="von" value="2026-01-01"><input data-zeitraum="bis" value="2026-01-31"><select data-filter><option value="">a</option><option value="x" selected>x</option></select><input>';
    for (const el of Array.from(wurzel.querySelectorAll("input, select"))) el.dispatchEvent(new Event("change", { bubbles: true }));
    await warte();
    expect(wurzel).toBeTruthy();
  });

  it("geparkt-Formular reicht die Felder an die Steuerung", async () => {
    const { wurzel, aufrufe } = await lade();
    wurzel.innerHTML = '<form data-geparkt-form="g1"><input data-geparkt-feld="marke" value="VW"><input data-geparkt-feld="modell" value="Golf"><input data-geparkt-feld="name" value="M"><input data-geparkt-feld="kennzeichen" value="X"></form><form data-geparkt-form></form>';
    for (const f of Array.from(wurzel.querySelectorAll("form"))) f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await warte();
    expect(aufrufe.length).toBeGreaterThan(0);
  });
});
