import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Bindings } from "../src/env.js";

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
