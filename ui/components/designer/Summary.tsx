"use client";

import type { DesignerDraft, DesignerStep } from "@/lib/api";
import { ErrorBox, Spinner } from "../bits";
import { CheckIcon } from "../icons";
import { KIND_NAME, reach, Section, TOOL_KIND } from "./parts";

const COVER_LABEL = { covered: "Covered", partly: "Partly", missing: "Not available" } as const;
const COVER_STYLE = {
  covered: { background: "color-mix(in srgb, var(--ok) 12%, transparent)", color: "var(--ok)" },
  partly: { background: "var(--warn-bg)", color: "var(--ink-dim)" },
  missing: { background: "var(--err-bg)", color: "var(--err)" },
} as const;

/** What the main button says: building straight away, or first reading the new tools. */
export function ctaLabel(draft: DesignerDraft): string {
  return draft.new_tools?.length ? "Review the new tools" : "Approve and build";
}

function missing(progress: DesignerStep[]): string[] {
  return progress.filter((p) => !p.done).map((p) => p.label);
}

export function Summary({
  draft,
  progress,
  ready,
  building,
  busy,
  error,
  onApprove,
}: {
  draft: DesignerDraft;
  progress: DesignerStep[];
  ready: boolean;
  building: boolean;
  busy: boolean;
  error?: string;
  onApprove: () => void;
}) {
  const total = progress.length;
  const done = progress.filter((p) => p.done).length;
  const empty = !draft.kind && !draft.display_name;
  const todo = missing(progress);
  const uses: { label: string; sub: string }[] = [
    ...(draft.tables || []).map((t) => ({ label: t, sub: "Table" })),
    ...(draft.sources || []).map((s) => ({ label: s.name || s.volume, sub: s.description || "Document folder" })),
    ...(draft.tools || []).map((t) => ({ label: t.description || t.ref, sub: TOOL_KIND[t.type] || "Tool" })),
  ];
  const cover = draft.coverage || [];
  const row = (c: NonNullable<DesignerDraft["coverage"]>[number], i: number) => (
    <li key={i} className="min-w-0 text-sm">
      <span className="mr-1.5 inline-block rounded-full px-2 py-0.5 text-[12px] font-semibold" style={COVER_STYLE[c.status]}>
        {COVER_LABEL[c.status]}
      </span>
      <span className="break-words">{c.need}</span>
      {c.note || c.by ? <span className="mt-0.5 block break-words faint">{c.note || c.by}</span> : null}
    </li>
  );

  return (
    <aside id="designer-summary" className="card flex h-fit flex-col p-0 lg:h-full lg:min-h-0" aria-label="Your assistant so far">
      {/* The checklist and the button stay put; what was understood scrolls below them. */}
      <div className="shrink-0 px-5 pt-5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[15px] font-semibold">Your assistant</h3>
          <span className="text-sm muted" aria-live="polite">
            {done} of {total} settled
          </span>
        </div>
        <div className="progress mt-2" role="progressbar" aria-label="How much is settled" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <span style={{ width: total ? `${(done / total) * 100}%` : "0%" }} />
        </div>

        <ul className="mt-3 space-y-1.5">
          {progress.map((p) => (
            <li key={p.key} className="flex items-center gap-2 text-[14.5px]">
              {p.done ? (
                <span aria-hidden style={{ color: "var(--ok)" }}>
                  <CheckIcon size={16} />
                </span>
              ) : (
                <span aria-hidden className="inline-block h-4 w-4 rounded-full" style={{ border: "1.5px solid var(--line)" }} />
              )}
              <span className={p.done ? "" : "muted"}>{p.label}</span>
              <span className="sr-only">{p.done ? "(settled)" : "(still needed)"}</span>
            </li>
          ))}
        </ul>

        {/* The main button sits with the checklist it depends on, so it is on screen whatever the
            page is scrolled to and however long the details below grow. */}
        <div className="mt-4">
          {error ? (
            <div className="mb-3">
              <ErrorBox>{error}</ErrorBox>
            </div>
          ) : null}
          <button type="button" className="btn btn-primary btn-lg w-full" disabled={!ready || busy || building} onClick={onApprove}>
            {building ? <Spinner label="Working…" /> : ctaLabel(draft)}
          </button>
          <p className="help text-center">
            {ready
              ? draft.new_tools?.length
                ? "Next you read the new tools. Nothing is created until you approve them."
                : "Nothing is created until you press this."
              : todo.length
                ? `Still needed: ${todo.slice(0, 2).join(", ")}${todo.length > 2 ? ` and ${todo.length - 2} more` : ""}.`
                : "Answer the last question to unlock this."}
          </p>
        </div>
      </div>

      <div className="mt-4 border-t px-5 pb-5 pt-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto" style={{ borderColor: "var(--line)" }}>
        {empty ? (
          <p className="text-sm muted">As you answer, what we understood appears here, so you can see it take shape.</p>
        ) : (
          <div>
            <Section title="Name">
              <span className="font-semibold">{draft.display_name || "Not named yet"}</span>
              {draft.kind ? <span className="mt-0.5 block text-sm muted">{KIND_NAME[draft.kind]}</span> : null}
            </Section>
            {draft.description ? <Section title="What it does">{draft.description}</Section> : null}
            {uses.length ? (
              <Section title="What it uses">
                <ul className="space-y-1.5">
                  {uses.slice(0, 8).map((u, i) => (
                    <li key={i} className="min-w-0">
                      <span className="break-words">{u.label}</span>
                      <span className="block text-[13px] faint">{u.sub}</span>
                    </li>
                  ))}
                  {uses.length > 8 ? <li className="text-sm muted">and {uses.length - 8} more</li> : null}
                </ul>
              </Section>
            ) : null}
            {draft.new_tools?.length ? (
              <Section title="New tools to create">
                <ul className="space-y-2">
                  {draft.new_tools.map((n) => (
                    <li key={n.fingerprint} className="min-w-0 text-sm">
                      <span className="break-words font-medium">{n.name}</span>
                      <span className="block break-words faint">{reach(n).join(" · ")}</span>
                    </li>
                  ))}
                </ul>
                <p className="help">You read each one before anything is created.</p>
              </Section>
            ) : null}
            {draft.access_decided ? (
              <Section title="Who can use it">
                {draft.access?.length ? (
                  <ul className="space-y-0.5">
                    {draft.access.map((a) => (
                      <li key={a.kind + a.principal} className="break-all">
                        {a.kind === "group" ? "Team: " : "Person: "}
                        {a.principal}
                      </li>
                    ))}
                  </ul>
                ) : (
                  "Nobody yet. You can share it later."
                )}
              </Section>
            ) : null}
            {cover.length ? (
              <Section title="What it can and cannot do">
                <ul className="space-y-2">{cover.slice(0, 3).map(row)}</ul>
                {cover.length > 3 ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm font-medium">Show the other {cover.length - 3}</summary>
                    <ul className="mt-2 space-y-2">{cover.slice(3).map((c, i) => row(c, i + 3))}</ul>
                  </details>
                ) : null}
              </Section>
            ) : null}
            {draft.gaps?.length ? (
              <Section title="Not included">
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {draft.gaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </Section>
            ) : null}
            {draft.instructions || draft.notes ? (
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer font-medium">How it will behave</summary>
                <p className="mt-2 whitespace-pre-wrap break-words muted">{draft.instructions || draft.notes}</p>
              </details>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}

/** On a phone the summary sits below a long conversation. This slim strip above the chat
 *  says how far along it is and jumps to it. It is a button that scrolls, not a link:
 *  this app uses the URL hash for its own navigation. It is not fixed to the screen,
 *  because anything fixed there covers the box people type in. */
export function ProgressStrip({ progress }: { progress: DesignerStep[] }) {
  const done = progress.filter((p) => p.done).length;
  const total = progress.length;
  return (
    <button
      type="button"
      className="card mb-3 flex w-full items-center gap-3 px-4 py-3 text-left lg:hidden"
      onClick={() => document.getElementById("designer-summary")?.scrollIntoView({ behavior: "smooth", block: "start" })}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3 text-sm">
          <span className="font-medium">Your assistant</span>
          <span className="muted">
            {done} of {total} settled
          </span>
        </span>
        <span className="progress mt-1.5 block" aria-hidden>
          <span style={{ width: total ? `${(done / total) * 100}%` : "0%" }} />
        </span>
      </span>
      <span className="shrink-0 text-sm" style={{ color: "var(--brand-deep)" }}>
        See details ↓
      </span>
    </button>
  );
}
