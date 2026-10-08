"use client";

import { useState } from "react";
import type { DesignerNewTool } from "@/lib/api";
import { Tag } from "../bits";
import { CopyIcon } from "../icons";
import { reach } from "./parts";

/** The one moment in the whole flow where something written by a model is about to be
 *  installed, so this screen is deliberately plain and unhurried: what it can reach in
 *  words first, the code for anyone who wants it, one tick per tool, and no way to
 *  continue until each is ticked. The code is behind a clearly labelled button (a wall
 *  of it is not a review for most people) but is one click away, and can be copied to
 *  send to someone technical. */

function codeOf(t: DesignerNewTool): string {
  return t.kind === "uc_function" ? `${t.sql}\n\n${t.example ? `-- try it:\n${t.example}` : ""}` : t.code || "";
}

function Tool({ t, ok, onTick }: { t: DesignerNewTool; ok: boolean; onTick: (v: boolean) => void }) {
  const [copied, setCopied] = useState(false);
  const text = codeOf(t);
  const lines = text.split("\n").length;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be blocked; the code is still selectable on screen.
    }
  }

  return (
    <section className="card p-5" aria-label={t.name}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[16px] font-semibold">{t.name}</h3>
        <Tag>{t.kind === "uc_function" ? "SQL function" : "Small tool"}</Tag>
        <span className="text-xs faint" title="A short code for exactly what you are approving">
          #{t.fingerprint.slice(0, 8)}
        </span>
      </div>
      <p className="mt-1 text-[15px] muted">{t.description}</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <h4 className="text-[13px] font-semibold uppercase tracking-[0.06em] faint">What it can reach</h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[15px]">
            {reach(t).map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
        {t.kind === "mcp" && t.abilities?.length ? (
          <div>
            <h4 className="text-[13px] font-semibold uppercase tracking-[0.06em] faint">What it can do</h4>
            <ul className="mt-1 space-y-1 text-[15px]">
              {t.abilities.map((a) => (
                <li key={a.name}>
                  {a.description}
                  {a.changes_data ? <span className="faint"> (saves or changes something)</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <details className="mt-4" open={t.kind === "uc_function"}>
        <summary className="cursor-pointer text-sm font-medium">
          {t.kind === "uc_function" ? "Show the SQL" : `Show the code (${lines} lines)`}
        </summary>
        <div className="mt-2">
          <button type="button" className="btn btn-quiet" onClick={copy}>
            <CopyIcon size={15} /> {copied ? "Copied" : "Copy it to send to someone technical"}
          </button>
          <pre
            className="mt-2 max-h-[420px] overflow-auto rounded-xl p-3 text-[12.5px] leading-5"
            style={{ background: "var(--bubble)", whiteSpace: "pre" }}
            tabIndex={0}
            aria-label={`The code of ${t.name}`}
          >
            {text}
          </pre>
        </div>
      </details>

      <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-[15px]">
        <input type="checkbox" className="mt-1 h-4 w-4" checked={ok} onChange={(e) => onTick(e.target.checked)} />
        <span>I have read what it can reach and I am happy for it to be created.</span>
      </label>
    </section>
  );
}

export function ReviewTools({
  tools,
  onBack,
  onCreate,
}: {
  tools: DesignerNewTool[];
  onBack: () => void;
  onCreate: (approved: string[]) => void;
}) {
  const [ok, setOk] = useState<Record<string, boolean>>({});
  const left = tools.filter((t) => !ok[t.fingerprint]).length;
  const plural = tools.length === 1 ? "tool" : "tools";

  return (
    <div className="max-w-4xl">
      <button type="button" className="btn btn-quiet mb-3" onClick={onBack}>
        ← Back to the conversation
      </button>
      <h2 className="text-xl font-semibold">Read the new {plural} before {tools.length === 1 ? "it is" : "they are"} created</h2>
      <p className="mt-1 max-w-3xl text-[15px] muted">
        {tools.length === 1 ? "This tool was" : "These tools were"} written by an AI model for this assistant. Nothing is installed until you approve.
      </p>

      <div className="mt-4 grid gap-3 rounded-xl p-4 sm:grid-cols-2" style={{ background: "var(--bubble)" }}>
        <div>
          <h3 className="text-sm font-semibold">What the automatic checks did</h3>
          <p className="mt-1 text-sm muted">
            Looked for things a tool like this has no reason to do: running commands, reading other files, or contacting websites that
            are not listed.
          </p>
        </div>
        <div>
          <h3 className="text-sm font-semibold">What they cannot do</h3>
          <p className="mt-1 text-sm muted">
            Prove the code is right or harmless. That is why you read this, and why it only ever gets the access listed on each card.
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-5">
        {tools.map((t) => (
          <Tool key={t.fingerprint} t={t} ok={!!ok[t.fingerprint]} onTick={(v) => setOk({ ...ok, [t.fingerprint]: v })} />
        ))}
      </div>

      {/* In the page's own flow, pinned to the bottom of the window while there is more to read above it. */}
      <div className="sticky bottom-0 z-10 mt-6 border-t py-3" style={{ background: "var(--canvas)", borderColor: "var(--line)" }}>
        <div className="flex flex-wrap items-center gap-3">
          <p className="mr-auto text-sm muted" aria-live="polite">
            {left === 0 ? "Creating takes a few minutes. Then your assistant is built." : `Tick ${left === tools.length ? "each tool" : left === 1 ? "the last tool" : `the other ${left}`} to continue.`}
          </p>
          <button type="button" className="btn btn-quiet" onClick={onBack}>
            Not yet
          </button>
          <button type="button" className="btn btn-primary btn-lg" disabled={left > 0} onClick={() => onCreate(tools.map((t) => t.fingerprint))}>
            Create the {plural} and build
          </button>
        </div>
      </div>
    </div>
  );
}
