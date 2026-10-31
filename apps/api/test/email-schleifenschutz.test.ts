import { describe, expect, it } from "vitest";
import { leseKopfzeilen, pruefeSchleifenschutz, type Kopfzeilen } from "../src/email/schleifenschutz.js";
import exchangeNdr from "./fixtures/mails/exchange-ndr.eml?raw";
import gmailVacation from "./fixtures/mails/gmail-vacation.eml?raw";
import normal from "./fixtures/mails/normale-kundenmail.eml?raw";
import outlook from "./fixtures/mails/outlook-abwesenheit.eml?raw";
import postfix from "./fixtures/mails/postfix-bounce.eml?raw";

const EIGENE = ["bewertung@kfz-beispiel.example"];
const pruefe = (roh: string, umschlagAbsender?: string) =>
  pruefeSchleifenschutz({ kopfzeilen: leseKopfzeilen(roh), eigeneAdressen: EIGENE, umschlagAbsender });
const mit = (zeilen: Record<string, string>): Kopfzeilen => {
  const m = new Map(Object.entries(zeilen).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (n) => m.get(n.toLowerCase()) ?? null };
};

describe("Schleifenschutz mit echten Header-Beispielen", () => {
  it("Outlook-Abwesenheit wird verworfen (Auto-Submitted)", () => {
    expect(pruefe(outlook)).toMatchObject({ verwerfen: true, grund: "auto_submitted" });
  });
  it("Gmail-Vacation wird verworfen", () => {
    expect(pruefe(gmailVacation)).toMatchObject({ verwerfen: true, grund: "auto_submitted" });
  });
  it("Exchange-NDR wird verworfen", () => {
    expect(pruefe(exchangeNdr)).toMatchObject({ verwerfen: true });
  });
  it("Postfix-Bounce wird verworfen", () => {
    expect(pruefe(postfix)).toMatchObject({ verwerfen: true });
  });
  it("normale Kundenmail geht durch", () => {
    expect(pruefe(normal)).toEqual({ verwerfen: false });
  });
  it("Folgezeilen werden entfaltet", () => {
    expect(leseKopfzeilen(postfix).get("content-type")).toContain("boundary=");
  });
});

describe("Schleifenschutz je Merkmal", () => {
  const faelle: Array<[string, Record<string, string>, string]> = [
    ["Auto-Submitted: auto-generated", { "Auto-Submitted": "auto-generated" }, "auto_submitted"],
    ["X-Autoreply", { "X-Autoreply": "yes" }, "x_autoreply"],
    ["X-Autorespond", { "X-Autorespond": "yes" }, "x_autorespond"],
    ["Precedence: bulk", { Precedence: "bulk" }, "precedence"],
    ["Precedence: junk", { Precedence: "Junk" }, "precedence"],
    ["Precedence: list", { Precedence: "list" }, "precedence"],
    ["List-Id", { "List-Id": "<news.beispiel.example>" }, "list_id"],
    ["Return-Path <>", { "Return-Path": "<>" }, "leerer_rueckpfad"],
    ["MAILER-DAEMON", { From: "MAILER-DAEMON@host.example (Mail Delivery System)" }, "systemabsender"],
    ["postmaster", { From: "Postmaster <postmaster@host.example>" }, "systemabsender"],
    ["multipart/report", { "Content-Type": "multipart/report; boundary=x" }, "bounce_bericht"],
    ["delivery-status", { "Content-Type": "multipart/mixed; report-type=delivery-status" }, "bounce_bericht"],
    ["X-Failed-Recipients", { "X-Failed-Recipients": "a@b.example" }, "x_failed_recipients"],
    ["eigene Absenderadresse", { From: "Bewertung <Bewertung@kfz-beispiel.example>" }, "eigene_adresse"],
  ];
  it.each(faelle)("%s", (_name, zeilen, grund) => {
    expect(pruefeSchleifenschutz({ kopfzeilen: mit(zeilen), eigeneAdressen: EIGENE })).toMatchObject({ verwerfen: true, grund });
  });

  it("leerer Hüllen-Absender gilt als Bounce", () => {
    expect(pruefeSchleifenschutz({ kopfzeilen: mit({}), umschlagAbsender: "" })).toMatchObject({ grund: "leerer_rueckpfad" });
  });
  it("Auto-Submitted: no lässt durch", () => {
    expect(pruefeSchleifenschutz({ kopfzeilen: mit({ "Auto-Submitted": "no", From: "a@b.example" }) })).toEqual({ verwerfen: false });
  });
  it("Precedence first-class lässt durch", () => {
    expect(pruefeSchleifenschutz({ kopfzeilen: mit({ Precedence: "first-class" }) })).toEqual({ verwerfen: false });
  });
});
