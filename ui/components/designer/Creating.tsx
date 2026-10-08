"use client";

import { ErrorBox, Spinner } from "../bits";
import { CheckIcon } from "../icons";

export type CreateStep = { label: string; state: "wait" | "work" | "done" | "fail"; note?: string };

/** What is happening while new tools are created and the assistant is built: every step
 *  listed up front, each showing where it is, so a few minutes of waiting is not a few
 *  minutes of wondering. On a failure it says which step, and offers the way back. */
export function Creating({
  steps,
  error,
  onRetry,
  onBack,
}: {
  steps: CreateStep[];
  error: string;
  onRetry: () => void;
  onBack: () => void;
}) {
  const icon = (s: CreateStep) =>
    s.state === "done" ? (
      <span aria-hidden style={{ color: "var(--ok)" }}>
        <CheckIcon size={18} />
      </span>
    ) : s.state === "work" ? (
      <Spinner />
    ) : s.state === "fail" ? (
      <span aria-hidden className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full text-[12px] font-bold" style={{ background: "var(--err-bg)", color: "var(--err)" }}>
        !
      </span>
    ) : (
      <span aria-hidden className="inline-block h-[18px] w-[18px] rounded-full" style={{ border: "1.5px solid var(--line)" }} />
    );
  const word = { wait: "waiting", work: "in progress", done: "done", fail: "failed" } as const;

  return (
    <div className="max-w-2xl">
      <div className="card p-7" role="status" aria-live="polite">
        <h2 className="text-xl font-semibold">{error ? "That did not finish" : "Setting things up"}</h2>
        <p className="mt-1 text-[15px] muted">
          {error ? "Nothing is lost: what was already made is kept, and trying again continues from there." : "This can take several minutes. You can leave this page open."}
        </p>
        <ul className="mt-5 space-y-3">
          {steps.map((s, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="mt-0.5 shrink-0">{icon(s)}</span>
              <span className="min-w-0 text-[15px]">
                <span className={s.state === "wait" ? "muted" : ""}>{s.label}</span>
                <span className="sr-only"> ({word[s.state]})</span>
                {s.note ? <span className="block break-words text-[13px] faint">{s.note}</span> : null}
              </span>
            </li>
          ))}
        </ul>
        {error ? (
          <div className="mt-5">
            <ErrorBox>{error}</ErrorBox>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary" onClick={onRetry}>
                Try again
              </button>
              <button type="button" className="btn btn-quiet" onClick={onBack}>
                Back to the summary
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
