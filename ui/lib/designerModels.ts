import type { DesignerModel, DesignerModels } from "./api";

/** Each admin's choice of AI model, remembered in their own browser.
 *
 *  This is a per-person convenience, not configuration: the portal stores nothing,
 *  and what a model can see is decided by the admin's own access, not by this. A
 *  saved choice that is no longer on offer (permission removed, model retired) is
 *  quietly dropped so the portal's default applies instead of an error. */
const KEY = "agent-portal-designer-models";

export const NO_CHOICE: DesignerModels = { chat: "", code: "", judge: "" };

export function loadChoice(offered: DesignerModel[]): DesignerModels {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<DesignerModels>;
    const names = new Set(offered.map((m) => m.name));
    const ok = (v: unknown) => (typeof v === "string" && names.has(v) ? v : "");
    return { chat: ok(raw.chat), code: ok(raw.code), judge: ok(raw.judge) };
  } catch {
    return { ...NO_CHOICE };
  }
}

export function saveChoice(c: DesignerModels) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    // Private windows can refuse storage; the choice then lasts for this visit only.
  }
}

/** Only what was actually chosen. Anything left out takes the portal's default, so a
 *  default can improve later without being frozen into every browser. */
export function chosen(c: DesignerModels): Partial<DesignerModels> {
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v)) as Partial<DesignerModels>;
}

/** The text a model option shows under its name. */
export function modelDetail(m: DesignerModel): string {
  return [m.fit, m.detail].filter(Boolean).join(" · ");
}
