import { Hono } from "hono";
import type { AppUmgebung } from "../env.js";

export const formularRouten = new Hono<AppUmgebung>();
