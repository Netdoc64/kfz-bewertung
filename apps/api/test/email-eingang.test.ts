import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verarbeiteEmail } from "../src/email/index.js";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const mail = (kopf: Record<string, string>, from: string) => ({ headers: new Headers(kopf), from }) as unknown as ForwardableEmailMessage;

afterEach(() => vi.restoreAllMocks());

describe("verarbeiteEmail: Schleifenschutz", () => {
  it("verwirft Autoreply und protokolliert den Grund", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await verarbeiteEmail(mail({ "Auto-Submitted": "auto-replied" }, "kunde@example.com"), env, ctx);
    expect(warn).toHaveBeenCalledWith("EMAIL_VERWORFEN", expect.objectContaining({ grund: "auto_submitted" }));
  });

  it("verwirft Mail von einer eigenen Adresse aus der Registry", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES ('mail.eigeneAdressen', ?1, 1, 'test')")
      .bind(JSON.stringify(["wir@kfz.example"]))
      .run();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await verarbeiteEmail(mail({ From: "wir@kfz.example" }, "wir@kfz.example"), env, ctx);
    expect(warn).toHaveBeenCalledWith("EMAIL_VERWORFEN", expect.objectContaining({ grund: "eigene_adresse" }));
  });

  it("normale Kundenmail wird nicht verworfen", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await verarbeiteEmail(mail({ From: "kunde@example.com" }, "kunde@example.com"), env, ctx);
    expect(warn).not.toHaveBeenCalled();
  });
});
