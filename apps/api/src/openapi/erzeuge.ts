import { z } from "zod";
import { ENDPUNKTE, type Endpunkt } from "./tabelle.js";

type Json = Record<string, unknown>;

const ZUGANG: Record<Endpunkt["zugang"], string> = {
  oeffentlich: "Ohne Anmeldung.",
  admin: "Nur Admin (Cloudflare Access).",
  geraet: "Nur gekoppeltes Gerät (Geräte-Token).",
};

const schema = (s: z.ZodType): Json => {
  const { $schema: _weg, ...rest } = z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) as Json;
  return rest;
};

export const openapiPfad = (pfad: string) => pfad.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

function operation(e: Endpunkt): Json {
  const pfadParameter = [...e.pfad.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
  const q = e.query ? schema(e.query) : undefined;
  const pflicht = new Set((q?.required as string[] | undefined) ?? []);
  const queryParameter = Object.entries((q?.properties as Record<string, Json> | undefined) ?? {}).map(([name, s]) => ({ name, in: "query", required: pflicht.has(name), schema: s }));
  const parameter = [...pfadParameter, ...queryParameter];
  return {
    tags: [e.tag],
    summary: e.zusammenfassung,
    description: ZUGANG[e.zugang],
    ...(parameter.length ? { parameters: parameter } : {}),
    ...(e.body ? { requestBody: { required: true, content: { "application/json": { schema: schema(e.body) } } } } : {}),
    responses: {
      "2XX": { description: "Erfolg" },
      default: { description: "Fehler im einheitlichen Fehlerformat (Code, Nachricht, Korrelations-ID)" },
    },
  };
}

/** Baut die Spezifikation aus der Routentabelle und den zod-Schemas der Routen. Rein und ohne Zeitstempel, damit der Vergleich mit der eingecheckten Datei stabil ist. */
export function erzeugeOpenapi(): Json {
  const paths: Record<string, Json> = {};
  for (const e of ENDPUNKTE) (paths[openapiPfad(e.pfad)] ??= {})[e.methode] = operation(e);
  return { openapi: "3.1.0", info: { title: "kfz-bewertung API", version: "1.0.0", description: "Erzeugt aus den zod-Schemas der Routen (npm run openapi). Nicht von Hand ändern." }, paths };
}

export const openapiText = (): string => `${JSON.stringify(erzeugeOpenapi(), null, 2)}\n`;
