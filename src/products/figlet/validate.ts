import type { Request } from "express";
import { listFonts, type Fonts } from "./render.js";

const MAX_TEXT_LEN = 256;
const MIN_WIDTH = 20;
const MAX_WIDTH = 200;

let allowedFonts: Set<string> | null = null;
function fontAllowed(name: string): boolean {
  if (!allowedFonts) allowedFonts = new Set(listFonts());
  return allowedFonts.has(name);
}

export interface ValidatedFigletInput {
  text: string;
  font: Fonts;
  width: number | undefined;
}

export type ValidationResult =
  | { ok: true; value: ValidatedFigletInput }
  | { ok: false; status: number; error: string };

export function validateFigletInput(query: Request["query"]): ValidationResult {
  const text = typeof query.text === "string" ? query.text : "";
  if (!text) return { ok: false, status: 400, error: "text query parameter is required" };
  if (text.length > MAX_TEXT_LEN)
    return { ok: false, status: 400, error: `text must be <= ${MAX_TEXT_LEN} characters` };

  const font = (typeof query.font === "string" && query.font ? query.font : "Standard") as Fonts;
  if (!fontAllowed(font))
    return { ok: false, status: 400, error: `unknown font: ${font} — see GET /figlet/fonts` };

  let width: number | undefined;
  if (typeof query.width === "string" && query.width !== "") {
    const n = Number(query.width);
    if (!Number.isInteger(n))
      return { ok: false, status: 400, error: "width must be an integer" };
    if (n < MIN_WIDTH || n > MAX_WIDTH)
      return { ok: false, status: 400, error: `width must be in [${MIN_WIDTH}, ${MAX_WIDTH}]` };
    width = n;
  }

  return { ok: true, value: { text, font, width } };
}
