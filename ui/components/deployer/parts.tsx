"use client";

import { ReactNode } from "react";
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
