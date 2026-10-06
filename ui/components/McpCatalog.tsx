"use client";

import { useMemo, useState } from "react";
import { BuilderTool, McpEntry, McpState } from "@/lib/api";
import { middleShort } from "@/lib/people";
import { ErrorBox, Pager, usePage } from "./bits";
import { CheckIcon, CloseIcon, SearchIcon, WandIcon } from "./icons";

const PAGE = 12;

/** True for a tool in the assistant's list that came from (or matches) the catalog. */
export function isCatalogTool(t: BuilderTool, catalog: McpEntry[] | null): boolean {
  return t.type === "app" && !!catalog?.some((m) => m.app_name === t.ref);
}

/** What a tool can do, in one line, without the health-check tool. */
function abilities(m: McpEntry) {
  return m.tools.filter((t) => t.name !== "ping").map((t) => t.description || t.name.replace(/_/g, " "));
}

function Tag({ tone, children, title }: { tone: "ok" | "warn" | "bad" | "muted" | "brand"; children: React.ReactNode; title?: string }) {
  const style =
    tone === "ok"
      ? { background: "color-mix(in srgb, var(--ok) 12%, transparent)", color: "var(--ok)" }
      : tone === "warn"
        ? { background: "var(--warn-bg)", color: "var(--warn-line)" }
        : tone === "bad"
          ? { background: "var(--err-bg)", color: "var(--err)" }
          : tone === "brand"
            ? { background: "var(--brand-soft)", color: "var(--brand-deep)" }
            : { background: "var(--bubble)", color: "var(--ink-faint)" };
  return (
    <span className="status-pill shrink-0 whitespace-nowrap" style={style} title={title}>
      {children}
    </span>
  );
}

/** The ready-made tools, built for a catalog of any size: search, filters, a
 *  paged grid of selectable cards, and the chosen tools listed underneath with
 *  their "when should it use this" note, so ticking never reshuffles the grid.
 *  Getting a tool ready (installing it if needed) happens by itself when the
 *  assistant is created or saved, so nothing about deployment is shown here. */
export function McpPicker({
  catalog,
  err,
  note,
  tools,
  setTools,
}: {
  catalog: McpEntry[] | null;
  err: string;
  note: string;
  tools: BuilderTool[];
  setTools: (t: BuilderTool[]) => void;
}) {
  const [q, setQ] = useState("");
  const [view, setView] = useState<"all" | "selected" | "files">("all");

  const list = catalog || [];
  const chosenOf = (m: McpEntry) => tools.find((t) => t.type === "app" && t.ref === m.app_name);
  const picked = list.filter((m) => chosenOf(m));
  // No cap on how many: Databricks documents 50 tools and agents together, but
  // its API took 123 and the assistant still answered (see `builder.py`).
  const used = tools.length;

  const s = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      list.filter(
        (m) =>
          (view === "all" || (view === "selected" ? !!chosenOf(m) : m.needs.volumes.length > 0)) &&
          (!s || [m.name, m.description, ...abilities(m)].join(" ").toLowerCase().includes(s))
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, view, s, tools]
  );
  const pg = usePage(shown, PAGE, [q, view]);

  function toggle(m: McpEntry) {
    if (chosenOf(m)) {
      setTools(tools.filter((t) => !(t.type === "app" && t.ref === m.app_name)));
    } else if (!m.problem) {
      setTools([...tools, { type: "app", ref: m.app_name, description: m.description, mcp: m.slug }]);
    }
  }

  const withFiles = list.filter((m) => m.needs.volumes.length > 0).length;

  return (
    <section className="card min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4" style={{ borderColor: "var(--line)" }}>
        <div className="min-w-0">
          <h4 className="text-[15px] font-semibold tracking-[-0.01em]">Tools</h4>
          <p className="mt-0.5 text-[13px] faint">Pick the tools it can use. We get them ready when you create the assistant.</p>
        </div>
        <span className="text-right" aria-live="polite">
          <span className="block text-[13px] tabular-nums muted">
            <strong className="font-semibold" style={{ color: "var(--ink)" }}>
              {used}
            </strong>{" "}
            added
          </span>
          <span className="block text-[11px] faint">Tools and other abilities</span>
        </span>
      </div>

      {err ? (
        <div className="p-5">
          <ErrorBox>{err}</ErrorBox>
        </div>
      ) : null}

      {!catalog && !err ? (
        <div className="grid gap-3 p-5 sm:grid-cols-2" aria-busy="true" aria-label="Loading the tools">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[104px] animate-pulse rounded-xl" style={{ background: "var(--bubble)" }} />
          ))}
        </div>
      ) : null}

      {catalog && list.length === 0 && !err ? (
        <p className="px-5 py-8 text-center text-sm muted">There are no ready-made tools yet. You can still add other abilities below.</p>
      ) : null}

      {list.length ? (
        <>
          <div className="flex flex-wrap items-center gap-3 px-5 pt-4">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
              {(
                [
                  ["all", "All", list.length],
                  ["selected", "Selected", picked.length],
                  ...(withFiles ? ([["files", "Works with files", withFiles]] as const) : []),
                ] as const
              ).map(([k, label, n]) => (
                <button key={k} type="button" className="filter-chip !min-h-[32px]" aria-pressed={view === k} onClick={() => setView(k)}>
                  {label}
                  <span className="count">{n}</span>
                </button>
              ))}
            </div>
            <label className="field flex w-full items-center gap-2 !py-0 sm:ml-auto sm:w-64">
              <span className="faint">
                <SearchIcon size={16} />
              </span>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`Search ${list.length} tools`}
                aria-label="Search tools"
                className="min-h-[34px] w-full bg-transparent outline-none"
              />
            </label>
          </div>

          {note ? <p className="px-5 pt-3 text-xs faint">{note}</p> : null}

          {shown.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm muted">
              {view === "selected" && !s ? "No tools selected yet." : `No tools match${s ? ` “${q}”` : ""}.`}{" "}
              {s || view !== "all" ? (
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    setQ("");
                    setView("all");
                  }}
                >
                  Show all tools
                </button>
              ) : null}
            </p>
          ) : (
            <ul className="grid gap-3 p-5 sm:grid-cols-2">
              {pg.rows.map((m) => {
                const on = !!chosenOf(m);
                const blocked = !on && !!m.problem;
                const why = m.problem ? "Not available right now" : "";
                const can = abilities(m);
                return (
                  <li key={m.slug} className="min-w-0">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      aria-disabled={blocked}
                      onClick={() => !blocked && toggle(m)}
                      className="pick-card"
                      data-on={on}
                      data-blocked={blocked}
                      title={why || m.name}
                    >
                      <span className="flex items-start gap-3">
                        <span aria-hidden className="kind-tile kind-supervisor !h-9 !w-9 !rounded-lg">
                          <WandIcon size={18} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14.5px] font-semibold">{middleShort(m.name, 46)}</span>
                          <span className="mt-0.5 line-clamp-2 text-[13px] muted">{m.description || can.join(" ") || "No description yet."}</span>
                        </span>
                        <span aria-hidden className="pick-check">
                          {on ? <CheckIcon size={14} /> : null}
                        </span>
                      </span>
                      <span className="mt-3 flex flex-wrap gap-1.5">
                        {m.problem ? <Tag tone="muted">Not available</Tag> : null}
                        {!m.problem && m.state === "failed" ? <Tag tone="warn" title={m.state_note}>Failed last time</Tag> : null}
                        {m.needs.volumes.length ? <Tag tone="brand">Works with files</Tag> : null}
                        {m.needs.secrets.length ? <Tag tone="warn">Needs setup</Tag> : null}
                        {m.tools.some((t) => t.changes_data) ? <Tag tone="muted">Changes data</Tag> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <Pager pg={pg} noun="tools" />
        </>
      ) : null}

      {picked.length ? (
        <div className="border-t" style={{ borderColor: "var(--line)" }}>
          <div className="flex items-baseline justify-between gap-3 px-5 pb-2 pt-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] faint">Selected ({picked.length})</p>
            <p className="hidden text-[12px] faint md:block">When should it use each one?</p>
          </div>
          <ul>
            {picked.map((m) => {
              const t = chosenOf(m)!;
              return (
                <ChosenRow
                  key={m.slug}
                  title={m.name}
                  sub={m.problem ? "Not available right now. Remove it, or it will be skipped." : m.needs.volumes.length ? "Gets access to the folders you choose in the Files step." : ""}
                  warn={!!m.problem}
                  value={t.description}
                  placeholder="For example: when someone sends a campaign spreadsheet"
                  onChange={(v) => setTools(tools.map((x) => (x === t ? { ...x, description: v } : x)))}
                  onRemove={() => toggle(m)}
                />
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** One chosen tool or ability: its name, an optional note, the "when should it
 *  use this" field and a remove button. Shared with "Other abilities". */
export function ChosenRow({
  title,
  sub,
  warn,
  value,
  placeholder,
  onChange,
  onRemove,
  locked,
}: {
  title: string;
  sub?: string;
  warn?: boolean;
  value: string;
  placeholder: string;
  onChange?: (v: string) => void;
  onRemove?: () => void;
  locked?: string;
}) {
  // Wide screens: name and note side by side, one line per tool, so twenty
  // chosen tools stay a short list. Phones: stacked.
  return (
    <li className="relative grid items-start gap-x-4 gap-y-2 px-5 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto]" style={{ borderTop: "1px solid var(--line)" }}>
      <div className="min-w-0 pr-10 md:pr-0 md:pt-2">
        <p className="truncate text-[14px] font-semibold" title={title}>
          {middleShort(title, 60)}
        </p>
        {sub ? (
          <p className="mt-0.5 break-words text-[12px] leading-snug" style={{ color: warn ? "var(--warn-line)" : "var(--ink-faint)" }}>
            {sub}
          </p>
        ) : null}
      </div>
      {onChange ? (
        <label className="block min-w-0">
          <span className="text-[12px] font-medium muted md:sr-only">When should it use this?</span>
          <input
            className="field mt-1 !min-h-[38px] md:mt-0"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            aria-label={`When should it use ${title}?`}
            title="When should it use this?"
          />
        </label>
      ) : (
        <span className="hidden md:block" />
      )}
      <div className="absolute right-3 top-2 md:static md:flex md:justify-end md:pt-0.5">
        {onRemove ? (
          <button type="button" className="icon-btn" onClick={onRemove} aria-label={`Remove ${title}`} title="Remove">
            <CloseIcon size={16} />
          </button>
        ) : locked ? (
          <span className="text-[12px] faint md:pt-2">{locked}</span>
        ) : null}
      </div>
    </li>
  );
}

/** One tool's progress, as a person would say it. */
export type ToolWait = { slug: string; name: string; state: McpState; line: string };

function plainStatus(t: ToolWait): string {
  if (t.state === "running") return "Ready";
  if (t.state === "failed") return t.line ? `Could not be made ready. ${t.line}` : "Could not be made ready.";
  if (t.state === "stopped") return "Switching it on…";
  if (t.state === "not_deployed") return "Waiting to start…";
  return (t.line || "Working on it.").replace(/\.$/, "…");
}

function took(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m} min ${s} s` : `${s} s`;
}

/** Shown under the Create button while the tools are got ready, so the wait can
 *  be watched: overall progress, each tool with where it is up to, and the time. */
export function ToolProgress({
  items,
  seconds,
  creating,
  failed,
}: {
  items: ToolWait[];
  seconds: number;
  creating: boolean;
  failed: boolean;
}) {
  const ready = items.filter((t) => t.state === "running").length;
  const pct = items.length ? Math.round((ready / items.length) * 100) : 0;
  return (
    <section className="card mt-5 overflow-hidden" role="status" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3.5" style={{ borderColor: "var(--line)" }}>
        <div className="min-w-0">
          <h4 className="text-[15px] font-semibold tracking-[-0.01em]">
            {failed ? "A tool could not be made ready" : creating ? "Creating your assistant…" : "Getting your tools ready"}
          </h4>
          <p className="mt-0.5 text-[13px] faint">
            {failed
              ? "Nothing was created. You can try again, or remove that tool."
              : creating
                ? "All tools are ready."
                : "This can take a few minutes the first time. Please keep this page open."}
          </p>
        </div>
        <span className="text-[13px] tabular-nums muted">
          {ready} of {items.length} ready · {took(seconds)}
        </span>
      </div>
      <div className="h-1 w-full" style={{ background: "var(--bubble)" }} aria-hidden>
        <div className="h-full transition-[width] duration-500" style={{ width: `${pct}%`, background: failed ? "var(--err)" : "var(--chart-1)" }} />
      </div>
      <ul className="max-h-[280px] overflow-y-auto">
        {items.map((t, i) => (
          <li key={t.slug} className="flex items-start gap-3 px-5 py-3" style={{ borderTop: i ? "1px solid var(--line)" : undefined }}>
            <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden>
              {t.state === "running" ? (
                <span style={{ color: "var(--ok)" }}>
                  <CheckIcon size={16} />
                </span>
              ) : t.state === "failed" ? (
                <span className="text-sm font-bold" style={{ color: "var(--err)" }}>
                  !
                </span>
              ) : (
                <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent faint" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium" title={t.name}>
                {t.name}
              </span>
              <span className="block text-[13px]" style={{ color: t.state === "failed" ? "var(--err)" : "var(--ink-faint)" }}>
                {plainStatus(t)}
              </span>
            </span>
            {t.state === "running" ? <Tag tone="ok">Ready</Tag> : t.state === "failed" ? <Tag tone="bad">Failed</Tag> : <Tag tone="muted">In progress</Tag>}
          </li>
        ))}
      </ul>
    </section>
  );
}
