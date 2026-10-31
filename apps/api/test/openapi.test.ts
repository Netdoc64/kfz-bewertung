import { describe, expect, it } from "vitest";
import eingecheckt from "../../../docs/openapi.json";
import { app } from "../src/index.js";
import { erzeugeOpenapi, openapiPfad } from "../src/openapi/erzeuge.js";
import { ENDPUNKTE } from "../src/openapi/tabelle.js";

describe("OpenAPI-Spezifikation", () => {
  it("ist aktuell: docs/openapi.json entspricht dem Generator (npm run openapi)", () => {
    expect(JSON.parse(JSON.stringify(erzeugeOpenapi()))).toEqual(eingecheckt);
  });

  it("kennt jede Route aus index.ts und keine erfundene", () => {
    const echt = app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method.toLowerCase()} ${openapiPfad(r.path)}`);
    const tabelle = ENDPUNKTE.map((e) => `${e.methode} ${openapiPfad(e.pfad)}`);
    expect([...new Set(tabelle)].sort()).toEqual([...new Set(echt)].sort());
    expect(new Set(tabelle).size).toBe(tabelle.length);
  });

  it("setzt Request-Bodies aus den zod-Schemas um", () => {
    const op = (eingecheckt.paths as Record<string, Record<string, any>>)["/api/admin/dsgvo/loeschung"]!.post;
    expect(op.requestBody.content["application/json"].schema.required).toEqual(["kontakt", "bestaetigung"]);
  });
});
