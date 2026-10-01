/** "SK" for "Soham Kamtikar" or "soham.kamtikar@databeat.io". */
export function initials(display: string): string {
  const base = (display || "").split("@")[0].replace(/[._-]+/g, " ").trim();
  const parts = base.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
}

/** Shorten a long name from the middle, keeping its start and its end.
 *  Auto-created names share a long prefix and differ only at the end
 *  ("... (auto-created) 2026-09-23 10:12:49"), so cutting the tail would make
 *  them all look identical. The full name belongs in a tooltip next to this. */
export function middleShort(name: string, max = 64): string {
  const s = (name || "").trim();
  if (s.length <= max) return s;
  const tail = Math.round(max * 0.45);
  return s.slice(0, max - tail - 1).trimEnd() + "…" + s.slice(-tail).trimStart();
}

/** "asha.rao@x.io" -> "Asha Rao", for places that have only an email. */
export function nameOf(user: string): string {
  const base = (user || "").split("@")[0].replace(/[._-]+/g, " ").trim();
  return base
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
