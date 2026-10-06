"use client";

import { useState } from "react";
import { dapi } from "@/lib/deployer";
import { Find } from "@/components/Ops";
import { ErrorBox, Select, Spinner, useLoad } from "@/components/bits";
import { CheckIcon } from "@/components/icons";

/** catalog: "" = always the newest version. tools: null = every tool. */
export type ToolsChoice = { catalog: string; tools: string[] | null };

/** Which MCP tools a client gets, and from which catalog version. The chosen
 *  tools ship inside the client's portal release, so the portal only offers
 *  these, and a rollback brings the old set back too. */
export function ToolsPicker({ value, onChange }: { value: ToolsChoice; onChange: (v: ToolsChoice) => void }) {
  const [q, setQ] = useState("");
  const cat = useLoad(() => dapi.mcps(value.catalog), [value.catalog]);
  const data = cat.data;
  const tools = data?.tools || [];
  const chosen = value.tools;
  const known = new Set(tools.map((t) => t.slug));
  const missing = (chosen || []).filter((s) => !known.has(s));
  const s = q.trim().toLowerCase();
  const shown = s ? tools.filter((t) => `${t.name} ${t.slug} ${t.description}`.toLowerCase().includes(s)) : tools;

  function toggle(slug: string) {
    const cur = new Set(chosen || []);
    if (cur.has(slug)) cur.delete(slug);
    else cur.add(slug);
    onChange({ ...value, tools: [...cur].sort() });
  }

  return (
    <div className="space-y-4">
      <div className="max-w-sm">
        <p className="text-[13px] font-medium muted">Catalog version</p>
        <div className="mt-1">
          <Select
            value={value.catalog}
            onChange={(v) => onChange({ ...value, catalog: v })}
            loading={!data && !cat.error}
            options={[
              { value: "", label: "Always the newest", detail: data ? `Now ${data.latest}. Updates with each deploy.` : undefined },
              ...(data?.versions || []).map((v) => ({ value: v, label: v, detail: v === data?.latest ? "Newest" : "Stays on this version" })),
            ]}
          />
        </div>
        <p className="help">Pin a version to keep a client on tools you have tested with them.</p>
      </div>

      <div>
        <p className="text-[13px] font-medium muted">Tools</p>
        <div className="seg mt-1" role="group" aria-label="Which tools">
          <button type="button" aria-pressed={chosen === null} onClick={() => onChange({ ...value, tools: null })}>
            All tools
          </button>
          <button type="button" aria-pressed={chosen !== null} onClick={() => onChange({ ...value, tools: chosen || [] })}>
            Choose tools
          </button>
        </div>
        <p className="help">
          {chosen === null
            ? "Every tool in the catalog, including ones added later."
            : `${chosen.length} chosen. Only these appear in their portal.`}
        </p>
      </div>

      {cat.error ? <ErrorBox>{cat.error}</ErrorBox> : null}
      {!data && !cat.error ? <Spinner label="Reading the catalog…" /> : null}

      {data && chosen !== null ? (
        tools.length === 0 ? (
          <p className="text-[13px] faint">This catalog version has no tools.</p>
        ) : (
          <div className="rounded-xl" style={{ border: "1px solid var(--line)" }}>
            {tools.length > 8 ? (
              <div className="border-b p-3" style={{ borderColor: "var(--line)" }}>
                <Find value={q} onChange={setQ} placeholder="Find a tool" />
              </div>
            ) : null}
            <ul className="max-h-80 overflow-y-auto">
              {shown.map((t, i) => {
                const on = chosen.includes(t.slug);
                return (
                  <li key={t.slug} style={{ borderTop: i ? "1px solid var(--line)" : undefined }}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-[var(--canvas)]"
                      onClick={() => toggle(t.slug)}
                    >
                      <span
                        className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md"
                        style={on ? { background: "var(--brand)", color: "#fff" } : { border: "1.5px solid var(--line)", background: "var(--surface)" }}
                        aria-hidden
                      >
                        {on ? <CheckIcon size={13} /> : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{t.name}</span>
                        {t.description ? <span className="line-clamp-2 text-[13px] muted">{t.description}</span> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
              {shown.length === 0 ? <li className="px-4 py-3 text-[13px] faint">No tool matches “{q.trim()}”.</li> : null}
            </ul>
          </div>
        )
      ) : null}

      {data && missing.length ? (
        <p className="rounded-lg px-3 py-2 text-[13px]" style={{ background: "var(--warn-bg)" }}>
          Not in {value.catalog || `the newest version (${data.latest})`}, so not shipped: {missing.join(", ")}.{" "}
          <button type="button" className="underline" onClick={() => onChange({ ...value, tools: (chosen || []).filter((x) => known.has(x)) })}>
            Remove
          </button>
        </p>
      ) : null}
    </div>
  );
}
