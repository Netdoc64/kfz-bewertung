import { Hono } from "hono";
import type { AppUmgebung } from "../env.js";

export const kennzahlenRouten = new Hono<AppUmgebung>();
