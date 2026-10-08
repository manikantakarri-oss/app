"use client";

import { useEffect, useState } from "react";
import { ErrorBox } from "../bits";
import { CheckIcon, CloseIcon, RocketIcon } from "../icons";

export type CreateStep = { label: string; state: "wait" | "work" | "done" | "fail"; note?: string };

/** What is happening while new tools are created and the assistant is built: every step
 *  listed up front on a timeline, each showing where it is, with the time so far, so a
 *  few minutes of waiting is not a few minutes of wondering. On a failure it says which
 *  step, and offers the way back. */
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
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (error) return;
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [error]);
  const word = { wait: "waiting", work: "in progress", done: "done", fail: "failed" } as const;
  const doneCount = steps.filter((s) => s.state === "done").length;

  const dot = (s: CreateStep, i: number) => {
    if (s.state === "done") return <CheckIcon size={14} />;
    if (s.state === "work") return <span className="dz-spin" aria-hidden />;
    if (s.state === "fail") return <CloseIcon size={13} />;
    return <span className="text-[12px] font-semibold">{i + 1}</span>;
  };

  return (
    <div className="mx-auto max-w-2xl">
      <div className="card overflow-hidden p-0" role="status" aria-live="polite">
        <div className="flex items-center gap-4 border-b px-7 py-6" style={{ borderColor: "var(--line)" }}>
          {error ? (
            <span
              aria-hidden
              className="inline-flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-full text-[22px] font-bold"
              style={{ background: "var(--err-bg)", color: "var(--err)" }}
            >
              !
            </span>
          ) : (
            <span className="dz-ring" aria-hidden>
              <RocketIcon size={24} />
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight">{error ? "That did not finish" : "Building your assistant"}</h2>
            <p className="mt-1 text-[14.5px] muted">
              {error
                ? "Nothing is lost: what was already made is kept, and trying again continues from there."
                : "This usually takes a few minutes. You can keep this page open while it works."}
            </p>
          </div>
          {!error ? (
            <span className="ml-auto hidden shrink-0 text-right sm:block">
              <span className="block text-[18px] font-semibold tabular-nums">
                {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
              </span>
              <span className="text-[12px] faint">
                {doneCount} of {steps.length} done
              </span>
            </span>
          ) : null}
        </div>

        <ol className="px-7 py-6">
          {steps.map((s, i) => (
            <li key={i} className="dz-tl-item" data-state={s.state}>
              <span className="dz-tl-dot">{dot(s, i)}</span>
              <span className="min-w-0 pt-0.5">
                <span className={s.state === "wait" ? "text-[15px] muted" : "text-[15px] font-medium"}>{s.label}</span>
                <span className="sr-only"> ({word[s.state]})</span>
                {s.note ? <span className="mt-0.5 block break-words text-[13px] faint">{s.note}</span> : null}
              </span>
            </li>
          ))}
        </ol>

        {error ? (
          <div className="border-t px-7 py-5" style={{ borderColor: "var(--line)" }}>
            <ErrorBox>{error}</ErrorBox>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary" onClick={onRetry}>
                Try again
              </button>
              <button type="button" className="btn btn-quiet" onClick={onBack}>
                Back to the conversation
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
