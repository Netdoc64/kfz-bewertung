import type { Bindings } from "../env.js";
import { fcmAnschluss } from "./fcm.js";
import type { PushAnschluss } from "./port.js";

export type { PushAnschluss } from "./port.js";
export { pushAttrappe, type GesendetePush } from "./attrappe.js";
export { fcmAnschluss } from "./fcm.js";

/** FCM-Anschluss, wenn beide Schlüsselnamen in der Umgebung stehen; sonst `undefined` (kein Push, kein Fehler). */
export function pushFuer(env: Pick<Bindings, "PUSH_FCM_PROJEKT" | "PUSH_FCM_DIENSTKONTO">): PushAnschluss | undefined {
  if (!env.PUSH_FCM_PROJEKT || !env.PUSH_FCM_DIENSTKONTO) return undefined;
  return fcmAnschluss({ projekt: env.PUSH_FCM_PROJEKT, dienstkonto: env.PUSH_FCM_DIENSTKONTO });
}
