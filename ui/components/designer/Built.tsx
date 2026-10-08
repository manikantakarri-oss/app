"use client";

import { useEffect, useState } from "react";
import {
  api,
  DesignerBuilt,
  DesignerDraft,
  DesignerModels,
  DesignerResult,
  DesignerTest,
} from "@/lib/api";
import { ErrorBox, Spinner } from "../bits";
import { Finished } from "../BuilderParts";
import { CheckIcon, RefreshIcon } from "../icons";
import { sleep } from "./parts";

type Stage = "planning" | "waiting" | "running" | "done" | "skipped" | "error" | "timeout";

/** The assistant exists: try it out. Questions are written from what was asked for, the
 *  new assistant answers them as the admin, and a different model marks the answers.
 *  Only "it looks right" is claimed, never "it is right". */
export function Built({
  built,
  models,
  onFinished,
}: {
  built: { result: DesignerBuilt; draft: DesignerDraft };
  models: Partial<DesignerModels>;
  onFinished: (d: Finished) => void;
}) {
  const { result, draft } = built;
  const [stage, setStage] = useState<Stage>(result.endpoint_name ? "planning" : "skipped");
  const [plan, setPlan] = useState<DesignerTest[]>([]);
  const [results, setResults] = useState<Record<number, DesignerResult | "running">>({});
  const [msg, setMsg] = useState("");
  const [again, setAgain] = useState(0);
  const [minutes, setMinutes] = useState(0);

  useEffect(() => {
    const ep = result.endpoint_name;
    if (!ep) return;
    let stop = false;
    (async () => {
      setResults({});
      setMsg("");
      setMinutes(0);
      setStage("planning");
      let tests: DesignerTest[];
      try {
        tests = (await api.designerTestPlan(draft, models)).tests;
      } catch (e: any) {
        if (!stop) {
          setMsg(e.message);
          setStage("error");
        }
        return;
      }
      if (stop) return;
      setPlan(tests);
      setStage("waiting");
      // It needs a few minutes to start (document assistants longer).
      let up = false;
      for (let i = 0; i < 150 && !stop; i++) {
        const s = await api.designerState(ep).catch(() => ({ state: "waiting" as const }));
        if (s.state === "ready") {
          up = true;
          break;
        }
        setMinutes(Math.floor((i * 10) / 60));
        await sleep(10000);
      }
      if (stop) return;
      if (!up) {
        setStage("timeout");
        return;
      }
      setStage("running");
      for (let i = 0; i < tests.length && !stop; i++) {
        setResults((r) => ({ ...r, [i]: "running" }));
        let out: DesignerResult;
        try {
          out = await api.designerTestRun(ep, tests[i].question, tests[i].expect, models);
        } catch (e: any) {
          out = { verdict: "ungraded", reason: e.message, answer: "" };
        }
        if (stop) return;
        setResults((r) => ({ ...r, [i]: out }));
      }
      if (!stop) setStage("done");
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [again]);

  const done = Object.values(results).filter((r): r is DesignerResult => r !== "running");
  const passed = done.filter((r) => r.verdict === "pass").length;
  const finished = stage === "done" || stage === "skipped" || stage === "error" || stage === "timeout";

  function finish() {
    onFinished({
      kind: "created",
      name: result.name,
      warnings: result.warnings,
      access: draft.access?.length || 0,
      variant: result.kind === "genie" ? "data" : result.kind === "knowledge" ? "docs" : "assistant",
      chat: result.kind === "genie" ? draft.chat !== false : undefined,
      deploying: result.deploying,
    });
  }

  const failed = done.filter((r) => r.verdict === "fail").length;
  const pct = (n: number) => (plan.length ? `${(n / plan.length) * 100}%` : "0%");
  let status: { label: string; tone: "work" | "ok" | "muted" } = { label: "Starting up", tone: "work" };
  if (stage === "running" || stage === "done") status = { label: "Running", tone: "ok" };
  if (stage === "skipped") status = { label: "Created", tone: "ok" };
  if (stage === "timeout") status = { label: "Still starting", tone: "muted" };

  return (
    <div className="mx-auto max-w-4xl">
      <div
        className="card overflow-hidden p-0"
        style={{ background: "radial-gradient(120% 140% at 0% 0%, var(--brand-soft) 0%, var(--surface) 55%)" }}
      >
        <div className="flex flex-wrap items-center gap-5 px-7 py-7">
          <span
            aria-hidden
            className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-white"
            style={{ background: "linear-gradient(135deg, var(--mark-from), var(--mark-to))", boxShadow: "0 14px 30px -14px var(--brand)" }}
          >
            <CheckIcon size={28} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="dz-eyebrow">Created</p>
            <h2 className="mt-1 break-words text-2xl font-semibold tracking-tight">{result.name}</h2>
            <p className="mt-1 max-w-2xl text-[14.5px] muted">
              {status.tone === "ok" && stage !== "skipped"
                ? "It is up and running. We tried it with some questions so you can see how it behaves before you share it."
                : "It takes a few minutes to start before anyone can chat with it. Meanwhile we try it with some questions, so you can see how it behaves."}
            </p>
          </div>
          <span className="status-pill" style={status.tone === "ok" ? { background: "color-mix(in srgb, var(--ok) 14%, transparent)", color: "var(--ok)" } : { background: "var(--bubble)", color: "var(--ink-dim)" }}>
            {status.tone === "work" ? <span className="dz-spin" aria-hidden /> : <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: "currentColor" }} />}
            {status.label}
          </span>
        </div>
      </div>

      {result.warnings?.length ? (
        <div className="mt-4 space-y-2">
          {result.warnings.map((w) => (
            <ErrorBox key={w}>{w}</ErrorBox>
          ))}
        </div>
      ) : null}
      {result.deploying?.length ? (
        <div className="notice mt-4">We are getting {result.deploying.join(", ")} ready for it. It is added by itself as soon as it is ready.</div>
      ) : null}

      <section className="card mt-4 overflow-hidden p-0" aria-label="Test questions">
        <div className="flex flex-wrap items-center gap-3 border-b px-6 py-4" style={{ borderColor: "var(--line)" }}>
          <div className="min-w-0 flex-1">
            <h3 className="text-[16px] font-semibold">Trying it out</h3>
            <p className="text-[13px] faint">Questions written from what you asked for, answered by your new assistant, marked by a different AI model.</p>
          </div>
          {stage === "done" || stage === "error" || stage === "timeout" ? (
            <button type="button" className="btn btn-quiet" onClick={() => setAgain((n) => n + 1)}>
              <RefreshIcon size={15} /> Run again
            </button>
          ) : null}
        </div>

        <div className="px-6 py-5">
          {stage === "skipped" ? (
            <p className="text-sm muted">This one has no chat version in the portal yet, so there is nothing to test here. Open it in Databricks to try it.</p>
          ) : null}
          {stage === "planning" ? <span className="dz-shimmer text-[14.5px] font-medium">Writing test questions from what you asked for…</span> : null}
          {stage === "waiting" ? (
            <div>
              <span className="dz-shimmer text-[14.5px] font-medium">
                Waiting for it to start{minutes ? ` · ${minutes} min so far` : ""}
              </span>
              <p className="mt-1 text-[13px] faint">
                This usually takes a few minutes; document assistants take longer. You do not have to wait: finish now and try it from Your
                assistants once it has started.
              </p>
            </div>
          ) : null}
          {stage === "error" ? <ErrorBox>{msg}</ErrorBox> : null}
          {stage === "timeout" ? (
            <p className="text-sm muted">
              It has not finished starting yet. Press “Run again” to keep waiting, or finish here and try it from Your assistants once it has
              started.
            </p>
          ) : null}

          {plan.length && (stage === "running" || stage === "done") ? (
            <div className="mb-5">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[15px]">
                  <b className="text-[22px] tabular-nums">{passed}</b>
                  <span className="muted"> of {plan.length} looked right</span>
                </p>
                <span className="text-[12.5px] faint">{stage === "running" ? `${done.length} of ${plan.length} asked` : "Done"}</span>
              </div>
              <div className="dz-score mt-2" aria-hidden>
                <span style={{ width: pct(passed), background: "var(--ok)" }} />
                <span style={{ width: pct(failed), background: "var(--err)" }} />
                <span style={{ width: pct(done.length - passed - failed), background: "var(--ink-faint)" }} />
              </div>
              {stage === "done" ? (
                <p className="mt-2 text-[12.5px] faint">
                  This checks that answers are sensible, not that every number is correct. Try a few questions you know the answer to.
                </p>
              ) : null}
            </div>
          ) : null}

          {plan.length && stage !== "error" ? (
            <ul className="space-y-2.5">
              {plan.map((t, i) => {
                const r = results[i];
                return (
                  <li key={i} className="rounded-xl border px-4 py-3" style={{ borderColor: "var(--line)" }}>
                    <div className="flex items-start gap-3">
                      <VerdictMark r={r} />
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-[15px] font-medium">{t.question}</p>
                        {r && r !== "running" ? <p className="mt-0.5 break-words text-[13.5px] muted">{r.reason}</p> : null}
                        {r && r !== "running" && r.answer ? (
                          <details className="mt-1.5 text-sm">
                            <summary className="cursor-pointer text-[13px] font-medium" style={{ color: "var(--brand-deep)" }}>
                              See its answer
                            </summary>
                            <p className="mt-1.5 whitespace-pre-wrap break-words rounded-lg px-3 py-2 muted" style={{ background: "var(--bubble)" }}>
                              {r.answer}
                            </p>
                          </details>
                        ) : null}
                      </div>
                      <Verdict r={r} />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </section>

      <div className="mt-5 flex justify-end">
        <button type="button" className={finished ? "btn btn-primary btn-lg" : "btn btn-quiet btn-lg"} onClick={finish}>
          {finished ? "Finish" : "Finish without waiting"}
        </button>
      </div>
    </div>
  );
}

function VerdictMark({ r }: { r: DesignerResult | "running" | undefined }) {
  const base = "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full";
  if (r === "running")
    return (
      <span className={base} style={{ color: "var(--brand-deep)", boxShadow: "0 0 0 1.5px var(--brand) inset" }} aria-hidden>
        <span className="dz-spin" />
      </span>
    );
  if (r && r.verdict === "pass")
    return (
      <span className={base} style={{ background: "color-mix(in srgb, var(--ok) 15%, transparent)", color: "var(--ok)" }} aria-hidden>
        <CheckIcon size={13} />
      </span>
    );
  if (r && r.verdict === "fail")
    return (
      <span className={base + " text-[13px] font-bold"} style={{ background: "var(--err-bg)", color: "var(--err)" }} aria-hidden>
        !
      </span>
    );
  return <span className={base} style={{ border: "1.5px dashed var(--line)" }} aria-hidden />;
}

function Verdict({ r }: { r: DesignerResult | "running" | undefined }) {
  if (r === "running")
    return (
      <span className="status-pill status-wait">
        <Spinner label="Asking" />
      </span>
    );
  if (!r) return <span className="status-pill status-wait">Waiting</span>;
  if (r.verdict === "pass") return <span className="status-pill status-ready">Looks right</span>;
  if (r.verdict === "fail")
    return (
      <span className="status-pill" style={{ background: "var(--err-bg)", color: "var(--err)" }}>
        Needs a look
      </span>
    );
  return <span className="status-pill status-wait">Not checked</span>;
}
