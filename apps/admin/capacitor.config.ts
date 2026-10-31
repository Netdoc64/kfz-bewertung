import type { CapacitorConfig } from "@capacitor/cli";

// Keine server.url: die API-Adresse kommt aus der Geräte-Kopplung, nicht aus dem Build.
const konfig: CapacitorConfig = {
  appId: "de.kfzbewertung.admin",
  appName: "kfz-bewertung",
  webDir: "dist",
};

export default konfig;
