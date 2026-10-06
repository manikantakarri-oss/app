"use client";

import { ReactNode, useEffect, useState } from "react";
import { CheckIcon, CloseIcon, CopyIcon } from "@/components/icons";
import { contrast, hexToRgb, HEX_RE } from "@/lib/brand";
import { initials } from "@/lib/people";
import { DeployRow, DeployStatus, HealthStatus } from "@/lib/deployer";
import { Tag } from "@/components/Ops";

/** Small shared pieces for the deployer's pages. The cards, rows, chips and
 *  tags themselves are the portal's own (Ops.tsx, Dashboard.tsx, bits.tsx), so
 *  both products look the same by construction. */

export function PageHead({ eyebrow, title, text, actions }: { eyebrow: string; title: ReactNode; text?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-5">
      <div className="min-w-0">
        <p className="text-[13px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--brand-deep)" }}>
          {eyebrow}
        </p>
        <h1 className="mt-1 break-words text-[28px] font-semibold leading-tight tracking-[-0.02em]">{title}</h1>
        {text ? <p className="mt-1.5 max-w-2xl text-[15px] muted">{text}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

const HEALTH: Record<HealthStatus, { label: string; tone: "ok" | "warn" | "bad" | "muted" }> = {
  healthy: { label: "Healthy", tone: "ok" },
  degraded: { label: "Degraded", tone: "warn" },
  down: { label: "Down", tone: "bad" },
  unverified: { label: "Running", tone: "ok" },
};

export function HealthTag({ status }: { status?: HealthStatus | "" }) {
  if (!status) return <Tag tone="muted">Not checked</Tag>;
  const h = HEALTH[status] || { label: status, tone: "muted" as const };
  return <Tag tone={h.tone}>{h.label}</Tag>;
}

export const DEPLOY: Record<DeployStatus, { label: string; tone: "ok" | "warn" | "bad" | "muted" }> = {
  requested: { label: "Queued", tone: "muted" },
  running: { label: "Deploying", tone: "warn" },
  succeeded: { label: "Live", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  rolled_back: { label: "Rolled back", tone: "warn" },
};

export function DeployTag({ row }: { row: DeployRow }) {
  const d = DEPLOY[row.status] || { label: row.status, tone: "muted" as const };
  const label = row.status === "succeeded" && row.action !== "deploy" ? "Restored" : d.label;
  return <Tag tone={d.tone}>{label}</Tag>;
}

export function Version({ v, dim }: { v: string; dim?: boolean }) {
  if (!v) return <span className="text-sm faint">None yet</span>;
  return (
    <span
      className="inline-flex items-center rounded-md px-2 py-0.5 font-mono text-[12.5px] font-semibold"
      style={dim ? { background: "var(--bubble)", color: "var(--ink-dim)" } : { background: "var(--brand-soft)", color: "var(--brand-deep)" }}
    >
      {v}
    </span>
  );
}

export function verb(r: DeployRow) {
  if (r.action === "auto_rollback") return "Automatic rollback to";
  if (r.action === "rollback") return "Rollback to";
  return "Deploy";
}

export function ago(iso?: string) {
  if (!iso) return "";
  const t = new Date(String(iso).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(iso)) ? "" : "Z")).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function when(iso?: string) {
  if (!iso) return "";
  const t = new Date(String(iso).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(iso)) ? "" : "Z"));
  return Number.isFinite(t.getTime())
    ? t.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : "";
}

export function person(actor: string) {
  if (!actor) return "someone";
  return actor.includes("@") ? actor.split("@")[0].replace(/[._]/g, " ") : actor;
}

export function hostLabel(h: string) {
  return h.replace(/^https?:\/\//, "");
}

export function Field({
  label,
  hint,
  children,
  error,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  error?: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="text-[13px] font-medium muted">{label}</span>
      <span className="mt-1 block">{children}</span>
      {error ? (
        <span className="help" style={{ color: "var(--err)" }}>
          {error}
        </span>
      ) : hint ? (
        <span className="help">{hint}</span>
      ) : null}
    </label>
  );
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline decoration-[var(--line)] underline-offset-2 hover:decoration-current">
      {children}
    </a>
  );
}

/** The portal's list row (Ops.tsx `Row`), with its detail rendered below the
 *  button rather than inside it, because these details hold links. */
export function OpenRow({
  mark,
  title,
  meta,
  tag,
  detail,
  open,
  onToggle,
}: {
  mark: ReactNode;
  title: ReactNode;
  meta: ReactNode;
  tag?: ReactNode;
  detail: ReactNode;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <li style={{ borderTop: "1px solid var(--line)" }}>
      <button type="button" className="flex w-full items-start gap-3 px-5 py-3 text-left transition hover:bg-[var(--canvas)]" onClick={onToggle} aria-expanded={open}>
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: "var(--brand-soft)", color: "var(--brand-deep)" }} aria-hidden>
          {mark}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm leading-snug">{title}</span>
          <span className="mt-0.5 block break-words text-xs faint">{meta}</span>
        </span>
        {tag}
      </button>
      {open ? <div className="pb-4 pl-16 pr-5">{detail}</div> : null}
    </li>
  );
}

/** -1, 0 or 1: how version a compares with b (v1.10.0 is newer than v1.9.2;
 *  a pre-release sorts before its release). */
export function compareVersions(a: string, b: string) {
  const parse = (v: string) => {
    const [main, pre = ""] = v.replace(/^v/, "").split("-", 2);
    return { n: main.split(".").map((x) => Number(x) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] || 0) !== (y.n[i] || 0)) return (x.n[i] || 0) > (y.n[i] || 0) ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

/** The newest version that is not a pre-release, or "". */
export function latestStable(releases: { version: string; prerelease: boolean }[] | null) {
  const stable = (releases || []).filter((r) => !r.prerelease).map((r) => r.version);
  return stable.sort((a, b) => compareVersions(b, a))[0] || "";
}

/** A focused task over the page: Escape or the backdrop closes it, and focus
 *  goes back where it was. Same look as the portal's quick switcher. */
export function Dialog({
  title,
  sub,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  sub?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      back?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="palette-backdrop flex items-start justify-center overflow-y-auto px-4 py-[8vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={`palette flex w-full flex-col ${wide ? "max-w-2xl" : "max-w-lg"}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b px-6 py-4" style={{ borderColor: "var(--line)" }}>
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
            {sub ? <p className="mt-0.5 text-[13px] muted">{sub}</p> : null}
          </div>
          <button type="button" className="icon-btn -mr-2 shrink-0" onClick={onClose} aria-label="Close">
            <CloseIcon size={18} />
          </button>
        </div>
        <div className="min-h-0 px-6 py-5">{children}</div>
        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t px-6 py-4" style={{ borderColor: "var(--line)" }}>
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The one thing to do next, at the top of a page. `tone` follows meaning:
 *  brand for the normal next step, warn when something needs fixing. */
export function NextStep({
  tone = "brand",
  icon,
  title,
  text,
  action,
}: {
  tone?: "brand" | "warn" | "bad";
  icon: ReactNode;
  title: ReactNode;
  text?: ReactNode;
  action?: ReactNode;
}) {
  const style =
    tone === "warn"
      ? { background: "var(--warn-bg)", borderColor: "color-mix(in srgb, var(--warn-line) 40%, var(--line))" }
      : tone === "bad"
        ? { background: "var(--err-bg)", borderColor: "color-mix(in srgb, var(--err) 35%, var(--line))" }
        : { background: "color-mix(in srgb, var(--brand-soft) 60%, var(--surface))", borderColor: "color-mix(in srgb, var(--brand) 35%, var(--line))" };
  const ink = tone === "warn" ? "var(--warn-line)" : tone === "bad" ? "var(--err)" : "var(--brand-deep)";
  return (
    <section className="mb-6 flex flex-wrap items-center gap-4 rounded-2xl border px-5 py-4" style={style} aria-live="polite">
      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: "var(--surface)", color: ink }} aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold">{title}</p>
        {text ? <p className="mt-0.5 text-[13px] muted">{text}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap gap-2">{action}</div> : null}
    </section>
  );
}

/** Copy text to the clipboard, with a brief "Copied" on the button. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-quiet !min-h-[32px] !px-3 !text-[13px]"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1600);
          },
          () => setDone(false)
        );
      }}
    >
      {done ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      {done ? "Copied" : label}
    </button>
  );
}

/** A client's logo, or their initials on their brand colour (text picked for
 *  contrast). `sm` is the size used in avatar stacks and chips. */
export function ClientMark({
  c,
  size = "md",
  ring,
}: {
  c: { name: string; brand_logo?: string; brand_color?: string };
  size?: "sm" | "md";
  ring?: boolean;
}) {
  const box = size === "sm" ? "h-7 w-7 rounded-md text-[10px]" : "h-9 w-9 rounded-lg text-[12px]";
  const edge = ring ? { boxShadow: "0 0 0 2px var(--surface)" } : {};
  if (c.brand_logo) {
    return (
      <span className={`inline-flex shrink-0 items-center justify-center overflow-hidden ${box}`} style={{ background: "#fff", border: "1px solid var(--line)", ...edge }} aria-hidden>
        <img src={c.brand_logo} alt="" className="h-full w-full object-contain p-[3px]" />
      </span>
    );
  }
  const color = c.brand_color && HEX_RE.test(c.brand_color) ? c.brand_color : "";
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center font-semibold ${box}`}
      style={{
        ...(color ? { background: color, color: contrast(hexToRgb(color), [255, 255, 255]) >= 3 ? "#fff" : "#111" } : { background: "var(--bubble)", color: "var(--ink-dim)" }),
        ...edge,
      }}
      aria-hidden
    >
      {initials(c.name)}
    </span>
  );
}
