import type { PushAnschluss } from "./port.js";

export interface GesendetePush {
  geraetePushToken: string;
  titel: string;
  text: string;
}

/** Attrappe für Tests: merkt sich alle Pushes, wirft auf Wunsch. */
export function pushAttrappe(wirft?: Error): PushAnschluss & { gesendet: GesendetePush[] } {
  const gesendet: GesendetePush[] = [];
  return {
    gesendet,
    async sende(geraetePushToken, titel, text) {
      if (wirft) throw wirft;
      gesendet.push({ geraetePushToken, titel, text });
    },
  };
}
