import { Hono } from "hono";
import type { AppUmgebung } from "../env.js";

export const anfragenRouten = new Hono<AppUmgebung>();
