/** "SK" for "Soham Kamtikar" or "soham.kamtikar@databeat.io". */
export function initials(display: string): string {
  const base = (display || "").split("@")[0].replace(/[._-]+/g, " ").trim();
  const parts = base.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
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
