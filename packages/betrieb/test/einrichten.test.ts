import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  einrichten,
  EinrichtenFehler,
  leseUmgebungen,
  parseJsonc,
  type Ausfuehren,
} from "../src/einrichten.ts";

const echteKonfig = readFileSync(new URL("../../../apps/api/wrangler.jsonc", import.meta.url), "utf8");

/** wrangler-Attrappe mit Zustand: create wirkt auf die nächste list. */
function attrappe(opts: { fehlerBei?: string; kaputtesJson?: boolean; d1VerschwindetNachCreate?: boolean } = {}) {
  const d1 = new Map<string, string>();
  const queues = new Set<string>();
  const buckets = new Set<string>();
  const aufrufe: string[] = [];
  const ausfuehren: Ausfuehren = async (args) => {
    const befehl = args.join(" ");
    aufrufe.push(befehl);
    if (opts.fehlerBei && befehl.startsWith(opts.fehlerBei)) {
      return { code: 1, stdout: "", stderr: "Not authenticated\nbitte login" };
    }
    if (befehl === "d1 list --json") {
      if (opts.kaputtesJson) return { code: 0, stdout: "kein json", stderr: "" };
      return { code: 0, stdout: JSON.stringify([...d1].map(([name, uuid]) => ({ name, uuid }))), stderr: "" };
    }
    if (args[0] === "d1" && args[1] === "create") {
      if (!opts.d1VerschwindetNachCreate) d1.set(args[2]!, `uuid-${args[2]}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (befehl === "queues list") return { code: 0, stdout: [...queues].map((q) => `│ ${q} │`).join("\n"), stderr: "" };
    if (args[0] === "queues" && args[1] === "create") {
      queues.add(args[2]!);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (befehl === "r2 bucket list") return { code: 0, stdout: [...buckets].map((b) => `name: ${b}`).join("\n"), stderr: "" };
    if (befehl.startsWith("r2 bucket create")) {
      buckets.add(args[3]!);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 2, stdout: "", stderr: "unbekannt" };
  };
  return { ausfuehren, aufrufe };
}

const anlegeAufrufe = (a: string[]) => a.filter((x) => / create /.test(` ${x}`));

describe("parseJsonc", () => {
  it("entfernt Kommentare und Endkommas, lässt Strings mit // unberührt", () => {
    const v = parseJsonc('{ /* x */ "a": "http://y", // z\n "b": [1,2,], "c": "q\\"//" }');
    expect(v).toEqual({ a: "http://y", b: [1, 2], c: 'q"//' });
  });
  it("toleriert unterminierten Blockkommentar", () => {
    expect(parseJsonc('{"a":1} /* offen')).toEqual({ a: 1 });
  });
});

describe("leseUmgebungen", () => {
  it("liest Produktion und jede env.* aus der echten wrangler.jsonc, inkl. Dead-Letter", () => {
    const u = leseUmgebungen(echteKonfig);
    expect(u.map((x) => x.name)).toEqual(["produktion", "entwicklung", "vorschau"]);
    expect(u[0]!.d1).toEqual(["kfz-bewertung"]);
    expect([...u[0]!.queues].sort()).toEqual(["bewertung", "bewertung-dead-letter"]);
    expect(u[0]!.r2).toEqual(["kfz-bewertung-berichte"]);
    expect(u[1]!.d1).toEqual(["kfz-bewertung-dev"]);
    expect(u[1]!.queues).toContain("bewertung-dead-letter-dev");
    expect(u[1]!.r2).toEqual(["kfz-bewertung-berichte-dev"]);
  });
  it("kommt mit fehlenden Abschnitten zurecht", () => {
    const u = leseUmgebungen('{ "env": { "x": {} } }');
    expect(u).toHaveLength(2);
    expect(u[1]).toMatchObject({ d1: [], queues: [], r2: [] });
  });
  it("meldet kaputte Konfiguration als EinrichtenFehler", () => {
    expect(() => leseUmgebungen("{ nein")).toThrow(EinrichtenFehler);
  });
});

describe("einrichten", () => {
  it("legt alles an und gibt je Umgebung die D1-ID aus; zweiter Lauf legt nichts an", async () => {
    const a = attrappe();
    const zeilen: string[] = [];
    const erst = await einrichten(echteKonfig, a.ausfuehren, (z) => zeilen.push(z));
    expect(erst.flatMap((e) => e.angelegt)).toHaveLength(3 * (1 + 2 + 1));
    expect(zeilen.join("\n")).toContain('"kfz-bewertung" -> database_id "uuid-kfz-bewertung"');
    expect(zeilen.join("\n")).toContain('"kfz-bewertung-dev" -> database_id "uuid-kfz-bewertung-dev"');

    const vorher = anlegeAufrufe(a.aufrufe).length;
    const zweit = await einrichten(echteKonfig, a.ausfuehren, () => {});
    expect(zweit.flatMap((e) => e.angelegt)).toEqual([]);
    expect(zweit.flatMap((e) => e.vorhanden)).toHaveLength(12);
    expect(anlegeAufrufe(a.aufrufe).length).toBe(vorher);
  });

  it("Queue-Name, der nur Teil eines längeren Namens ist, gilt nicht als vorhanden", async () => {
    const aufrufe: string[] = [];
    const ausf: Ausfuehren = async (args) => {
      aufrufe.push(args.join(" "));
      return { code: 0, stdout: args.join(" ") === "queues list" ? "bewertung-dead-letter" : "", stderr: "" };
    };
    await einrichten('{"queues":{"producers":[{"queue":"bewertung"}]}}', ausf, () => {});
    expect(aufrufe).toContain("queues create bewertung");
  });

  it("wrangler-Fehler bricht klar ab", async () => {
    const a = attrappe({ fehlerBei: "queues create" });
    const p = einrichten(echteKonfig, a.ausfuehren, () => {});
    await expect(p).rejects.toThrow(/queues create bewertung endete mit Code 1: Not authenticated \| bitte login/);
  });

  it("nimmt stdout als Fehlergrund, wenn stderr leer ist", async () => {
    const ausf: Ausfuehren = async () => ({ code: 3, stdout: "nur stdout", stderr: "" });
    await expect(einrichten('{"r2_buckets":[{"bucket_name":"b"}]}', ausf, () => {})).rejects.toThrow(/nur stdout/);
  });

  it("bricht bei kaputtem d1-JSON ab", async () => {
    const a = attrappe({ kaputtesJson: true });
    await expect(einrichten(echteKonfig, a.ausfuehren, () => {})).rejects.toThrow(/kein JSON/);
  });

  it("bricht ab, wenn die D1 nach dem Anlegen fehlt", async () => {
    const a = attrappe({ d1VerschwindetNachCreate: true });
    await expect(einrichten(echteKonfig, a.ausfuehren, () => {})).rejects.toThrow(/nicht in der Liste/);
  });

  it("ignoriert D1-Listeneinträge ohne name/uuid", async () => {
    const ausf: Ausfuehren = async (args) => ({
      code: 0,
      stdout: args[0] === "d1" ? JSON.stringify([{ name: 1 }, { name: "d", uuid: "u" }]) : "",
      stderr: "",
    });
    const e = await einrichten('{"d1_databases":[{"database_name":"d"}]}', ausf, () => {});
    expect(e[0]!.d1Ids).toEqual({ d: "u" });
  });
});
