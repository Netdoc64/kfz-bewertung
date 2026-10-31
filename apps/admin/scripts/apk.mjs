// Baut die Debug-APK: Web-Build -> cap sync android -> gradlew assembleDebug.
// Plattformunabhängig; JDK und Android SDK müssen vorhanden sein (siehe README).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const admin = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const env = { ...process.env };

function suche(kandidaten, pruefDatei) {
  return kandidaten.find((k) => k && existsSync(join(k, pruefDatei)));
}

// Gängige Installationsorte, falls die Variablen nicht gesetzt sind.
const lokal = process.env.LOCALAPPDATA ?? "";
const heim = process.env.HOME ?? process.env.USERPROFILE ?? "";
if (!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT) {
  const sdk = suche(
    [join(lokal, "Android", "Sdk"), join(heim, "Android", "Sdk"), join(heim, "Library", "Android", "sdk")],
    "platforms",
  );
  if (sdk) env.ANDROID_HOME = sdk;
}
const javaName = windows ? "java.exe" : "java";
const javaVorhanden = (home) => home && existsSync(join(home, "bin", javaName));
if (!javaVorhanden(env.JAVA_HOME)) {
  delete env.JAVA_HOME;
  const jdk = [
    "C:\\Program Files\\Android\\Android Studio\\jbr",
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
    "/opt/android-studio/jbr",
  ].find(javaVorhanden);
  if (jdk) env.JAVA_HOME = jdk;
}

const fehlt = [];
if (!env.JAVA_HOME && spawnSync("java", ["-version"], { shell: windows }).status !== 0) {
  fehlt.push("JDK (JAVA_HOME oder java im PATH)");
}
if (!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT) fehlt.push("Android SDK (ANDROID_HOME)");
if (fehlt.length) {
  console.error(`apk: Voraussetzung fehlt: ${fehlt.join("; ")}. Siehe README, Abschnitt „Android-APK“.`);
  process.exit(2);
}

function lauf(befehl, args, cwd = admin) {
  const r = spawnSync(befehl, args, { cwd, env, stdio: "inherit", shell: windows });
  if (r.status !== 0) {
    console.error(`apk: „${befehl} ${args.join(" ")}“ endete mit ${r.status ?? r.signal}`);
    process.exit(r.status || 1);
  }
}

const npx = windows ? "npx.cmd" : "npx";
lauf(npx, ["vite", "build"]);
lauf(npx, ["cap", "sync", "android"]);
const android = join(admin, "android");
lauf(join(android, windows ? "gradlew.bat" : "gradlew"), ["assembleDebug"], android);

const apk = join(admin, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
if (!existsSync(apk)) {
  console.error(`apk: erwartete Datei fehlt: ${apk}`);
  process.exit(1);
}
console.log(`apk: fertig -> ${apk}`);

