import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const text = readFileSync(new URL("../../../.github/workflows/deploy.yml", import.meta.url), "utf8");
const pos = (teil: string): number => {
  const i = text.indexOf(teil);
  expect(i, `fehlt: ${teil}`).toBeGreaterThan(-1);
  return i;
};

describe("deploy.yml", () => {
  it("läuft Sperre → Migration → Deploy → Rauchtest", () => {
    const reihe = [
      "platzhalter.mjs",
      "wrangler d1 migrations apply",
      "npx wrangler deploy",
      "npm run rauchtest --",
    ].map(pos);
    expect([...reihe].sort((a, b) => a - b)).toEqual(reihe);
  });

  it("wendet Migrationen remote an und kennt --env vorschau", () => {
    expect(text).toContain("migrations apply kfz-bewertung-vorschau --remote --env vorschau");
    expect(text).toContain("migrations apply kfz-bewertung --remote");
    expect(text).toContain("wrangler deploy --env vorschau");
  });

  it("prüft das Token zuerst und überspringt alle weiteren Schritte ohne", () => {
    expect(pos("name: Token prüfen")).toBeLessThan(pos("uses: actions/checkout"));
    expect(text).toContain("::notice::");
    expect(text).toContain("gesetzt=false");
    const schritte = text.split(/^      - /m).slice(2);
    expect(schritte.length).toBeGreaterThan(4);
    for (const s of schritte) expect(s).toContain("if: steps.token.outputs.gesetzt == 'true'");
  });

  it("startet nach grünem test auf main und per workflow_dispatch mit Standard vorschau", () => {
    expect(text).toMatch(/workflow_run:\s+workflows: \[CI\]\s+types: \[completed\]\s+branches: \[main\]/);
    expect(text).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(text).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(text).toMatch(/workflow_dispatch:[\s\S]*default: vorschau/);
  });

  it("hat nur lesende Rechte, Concurrency je Umgebung und nur Secret-Namen", () => {
    expect(text).toMatch(/permissions:\s+contents: read/);
    expect(text).toMatch(/concurrency:\s+group: deploy-\$\{\{ github\.event\.inputs\.umgebung/);
    expect(text).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(text).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
    expect(text).not.toMatch(/CLOUDFLARE_API_TOKEN:\s+[^$\s]/);
  });

  it("überspringt den Rauchtest ohne URL-Variable mit Hinweis", () => {
    expect(text).toContain("vars.RAUCHTEST_URL_VORSCHAU");
    expect(text).toMatch(/-z "\$URL"[\s\S]*::notice::[\s\S]*else[\s\S]*rauchtest/);
  });
});
