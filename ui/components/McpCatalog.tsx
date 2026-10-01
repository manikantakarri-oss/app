"use client";

import { BuilderTool, McpEntry, McpState } from "@/lib/api";
import { ErrorBox, Spinner } from "./bits";

/** True for a tool in the assistant's list that came from (or matches) the catalog. */
export function isCatalogTool(t: BuilderTool, catalog: McpEntry[] | null): boolean {
  return t.type === "app" && !!catalog?.some((m) => m.app_name === t.ref);
}

/** The ready-made tools. The person only ticks what they want; getting a tool
 *  ready (installing it if it is not there yet) happens by itself when the
 *  assistant is created or saved, so nothing about that is shown here. */
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
  function toggle(m: McpEntry, on: boolean) {
    if (on) {
      if (tools.some((t) => t.type === "app" && t.ref === m.app_name)) return;
      setTools([...tools, { type: "app", ref: m.app_name, description: m.description, mcp: m.slug }]);
    } else {
      setTools(tools.filter((t) => !(t.type === "app" && t.ref === m.app_name)));
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-[15px] font-semibold">Tools</h4>
        <p className="mt-0.5 text-[14px] muted">Tick the tools you want it to use. We take care of getting them ready.</p>
      </div>

      {err ? <ErrorBox>{err}</ErrorBox> : null}
      {note ? <p className="help">{note}</p> : null}
      {!catalog && !err ? <Spinner label="Loading the tools…" /> : null}
      {catalog && catalog.length === 0 && !err ? <p className="help">There are no tools to choose from yet.</p> : null}

      <ul className="space-y-3">
        {(catalog || []).map((m) => {
          const chosen = tools.find((t) => t.type === "app" && t.ref === m.app_name);
          const can = m.tools.filter((t) => t.name !== "ping");
          return (
            <li
              key={m.slug}
              className="rounded-xl p-4"
              title={m.problem || undefined}
              style={{
                border: "1px solid " + (chosen ? "var(--brand)" : "var(--line)"),
                background: chosen ? "var(--brand-soft)" : "var(--surface)",
              }}
            >
              <label className={"flex items-start gap-3 " + (m.problem ? "opacity-70" : "cursor-pointer")}>
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0"
                  checked={!!chosen}
                  disabled={!!m.problem}
                  onChange={(e) => toggle(m, e.target.checked)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold">{m.name}</span>
                  {m.description ? <span className="mt-0.5 block text-[14px] muted">{m.description}</span> : null}
                  {can.length ? (
                    <span className="mt-1.5 block text-[13px] muted">
                      <span className="font-medium">What it can do:</span>{" "}
                      {can.map((t) => t.description || t.name.replace(/_/g, " ")).join(" ")}
                    </span>
                  ) : null}
                  {m.problem ? <span className="help">Not available right now.</span> : null}
                  {!m.problem && m.state === "failed" ? (
                    <span className="help">We could not get this ready last time. We will try again.</span>
                  ) : null}
                  {m.needs.volumes.length ? (
                    <span className="help">
                      Works with files. It is given access to the folders you choose in the Files step.
                    </span>
                  ) : null}
                  {m.needs.secrets.length ? (
                    <span className="help">Needs an account connected first. Your administrator sets that up.</span>
                  ) : null}
                </span>
              </label>

              {chosen ? (
                <label className="mt-3 block pl-7">
                  <span className="text-[13px] font-medium muted">When should it use this?</span>
                  <input
                    className="field mt-1"
                    value={chosen.description}
                    onChange={(e) =>
                      setTools(tools.map((x) => (x === chosen ? { ...x, description: e.target.value } : x)))
                    }
                    placeholder="For example: when someone sends a campaign spreadsheet"
                  />
                </label>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
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

/** Shown under the Create button while the tools are got ready, so the wait can be
 *  watched: each tool with where it is up to, and how long it has been. */
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
  return (
    <div
      className="mt-5 rounded-xl p-4"
      style={{ border: "1px solid var(--line)", background: "var(--surface)" }}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[15px] font-semibold">
          {failed ? "A tool could not be made ready" : creating ? "Creating your assistant…" : "Getting your tools ready"}
        </h4>
        <span className="text-[13px] faint">Time so far: {took(seconds)}</span>
      </div>
      {!failed && !creating ? (
        <p className="mt-1 text-[13px] muted">
          This can take a few minutes the first time. Please keep this page open.
        </p>
      ) : null}
      <ul className="mt-3 space-y-2">
        {items.map((t) => (
          <li key={t.slug} className="flex items-start gap-3 text-[14px]">
            <span className="mt-0.5 w-5 shrink-0 text-center" aria-hidden>
              {t.state === "running" ? (
                <span style={{ color: "var(--ok)" }}>✓</span>
              ) : t.state === "failed" ? (
                <span style={{ color: "var(--err)" }}>!</span>
              ) : (
                <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent align-middle" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="font-medium">{t.name}</span>
              <span className="block muted" style={t.state === "failed" ? { color: "var(--err)" } : undefined}>
                {plainStatus(t)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
