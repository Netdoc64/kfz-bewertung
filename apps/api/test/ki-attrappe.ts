import Anthropic from "@anthropic-ai/sdk";
import type { KiAntwort, KiClient } from "../src/ki/index.js";

export type Skript = KiAntwort | Error;

export interface KiAttrappe extends KiClient {
  /** Alle Anfragen, die der Adapter gestellt hat (Parameter und Optionen). */
  aufrufe: Array<{ params: Record<string, any>; optionen: Record<string, unknown> | undefined }>;
}

/** Gefälschter Client: liefert die Skript-Einträge der Reihe nach, wirft Fehler-Einträge. Kein Netz, kein Schlüssel. */
export function kiAttrappe(...skript: Skript[]): KiAttrappe {
  const aufrufe: KiAttrappe["aufrufe"] = [];
  return {
    aufrufe,
    messages: {
      async create(params, optionen) {
        aufrufe.push({ params, optionen });
        const s = skript.shift();
        if (!s) throw new Error("Attrappe: keine Antwort mehr im Skript");
        if (s instanceof Error) throw s;
        return s;
      },
    },
  };
}

export const antwortText = (text: string, ein = 1000, aus = 200, stop = "end_turn"): KiAntwort => ({
  content: [{ type: "text", text }],
  stop_reason: stop,
  usage: { input_tokens: ein, output_tokens: aus },
});

export const antwortJson = (wert: unknown, ein?: number, aus?: number) => antwortText(JSON.stringify(wert), ein, aus);

export const refusal = (ein = 100, aus = 0): KiAntwort => ({ content: [], stop_reason: "refusal", usage: { input_tokens: ein, output_tokens: aus } });

export const zeitueberschreitung = () => new Anthropic.APIConnectionTimeoutError();
export const serverfehler = () => new Anthropic.InternalServerError(500, { type: "error" }, "overloaded", new Headers());
