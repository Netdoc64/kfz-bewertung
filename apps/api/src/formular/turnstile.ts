import type { Bindings } from "../env.js";
import { AppFehler } from "../fehler/app-fehler.js";

/** Prüfadresse von Cloudflare (technische Konstante). */
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Prüft das Turnstile-Token. Ohne Geheimnis lässt nur die Entwicklung durch; Produktion und
 * Vorschau weisen ab (fail closed). Mit Geheimnis gilt: kein Token, ungültiges Token oder
 * nicht erreichbare Prüfung ⇒ abgelehnt.
 */
export async function pruefeTurnstile(env: Pick<Bindings, "TURNSTILE_GEHEIMNIS" | "UMGEBUNG">, token: unknown, ip?: string): Promise<void> {
  const geheimnis = env.TURNSTILE_GEHEIMNIS;
  if (!geheimnis) {
    if (env.UMGEBUNG === "entwicklung") return;
    throw new AppFehler("BOT_SCHUTZ_NICHT_KONFIGURIERT");
  }
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) throw new AppFehler("BOT_SCHUTZ_ABGELEHNT");

  const form = new URLSearchParams({ secret: geheimnis, response: token });
  if (ip) form.set("remoteip", ip);
  let ok = false;
  try {
    const antwort = await fetch(SITEVERIFY, { method: "POST", body: form });
    ok = antwort.ok && ((await antwort.json()) as { success?: unknown }).success === true;
  } catch {
    ok = false;
  }
  if (!ok) throw new AppFehler("BOT_SCHUTZ_ABGELEHNT");
}
