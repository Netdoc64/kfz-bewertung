import { it } from "vitest";
import { bewerte } from "../src/bewertung/bewerten.js";
import { GOLDEN_EINSTELLUNGEN as E } from "./golden/einstellungen.js";
import * as D from "./golden/daten.js";
it("probe", async () => {
  const f = [["polo", D.POLO, [D.POLO_INSERATE]], ["golf", D.GOLF, D.GOLF_STUFEN], ["x5", D.X5, [D.X5_INSERATE]], ["selten", D.SELTEN, [D.SELTEN_INSERATE]]] as const;
  for (const [n, fz, st] of f) {
    const r = await bewerte({ fahrzeug: fz, suche: D.festeSuche(st as never), einstellungen: E, heute: D.HEUTE });
    const { vergleiche, ...rest } = r;
    console.log(n, JSON.stringify(rest));
  }
});
