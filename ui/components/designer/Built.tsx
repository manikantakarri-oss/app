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

  return (
    <div className="max-w-4xl">
      <div className="card p-7 text-center">
        <div aria-hidden className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full" style={{ background: "var(--brand-soft)", color: "var(--brand-deep)" }}>
          <CheckIcon size={26} />
        </div>
        <h2 className="text-xl font-semibold">“{result.name}” has been created</h2>
        <p className="mt-2 text-[15px] muted">
          It needs a few minutes to start before anyone can chat with it. While it does, we try it with some questions, so you
          can see how it behaves.
        </p>
      </div>

      {result.warnings?.length ? (
        <div className="mt-4 space-y-2">
          {result.warnings.map((w) => (
            <ErrorBox key={w}>{w}</ErrorBox>
          ))}
        </div>
      ) : null}
      {result.deploying?.length ? (
        <div className="card mt-4 p-5 text-[15px] muted">
          We are getting {result.deploying.join(", ")} ready for it. It is added by itself as soon as it is ready.
        </div>
      ) : null}

      <section className="card mt-4 p-6" aria-label="Test questions">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-[15px] font-semibold">Trying it out</h3>
          {stage === "done" || stage === "error" || stage === "timeout" ? (
            <button type="button" className="btn btn-quiet" onClick={() => setAgain((n) => n + 1)}>
              <RefreshIcon size={15} /> Run again
            </button>
          ) : null}
        </div>

        {stage === "skipped" ? (
          <p className="mt-2 text-sm muted">
            This one has no chat version in the portal yet, so there is nothing to test here. Open it in Databricks to try it.
          </p>
        ) : null}
        {stage === "planning" ? (
          <p className="mt-3">
            <Spinner label="Writing test questions…" />
          </p>
        ) : null}
        {stage === "waiting" ? (
          <div className="mt-3">
            <Spinner label={`Waiting for it to start${minutes ? ` (${minutes} min so far)` : ""}. This usually takes a few minutes; documents take longer.`} />
            <p className="help">You do not have to wait. Finish now and try it from Your assistants once it has started.</p>
          </div>
        ) : null}
        {stage === "error" ? (
          <div className="mt-3">
            <ErrorBox>{msg}</ErrorBox>
          </div>
        ) : null}
        {stage === "timeout" ? (
          <p className="mt-2 text-sm muted">
            It has not finished starting yet. Press “Run again” to keep waiting, or finish here and try it from Your assistants once it
            has started.
          </p>
        ) : null}
        {stage === "done" ? (
          <p className="mt-2 text-[15px]">
            <b>
              {passed} of {plan.length}
            </b>{" "}
            looked right.{" "}
            <span className="muted">
              This checks that answers are sensible, not that every number is correct. Try a few questions you know the answer to.
            </span>
          </p>
        ) : null}

        {plan.length && stage !== "error" ? (
          <ul className="mt-4 divide-y" style={{ borderColor: "var(--line)" }}>
            {plan.map((t, i) => {
              const r = results[i];
              return (
                <li key={i} className="py-3" style={{ borderColor: "var(--line)" }}>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-[15px] font-medium">{t.question}</p>
                      {r && r !== "running" ? <p className="mt-0.5 break-words text-sm muted">{r.reason}</p> : null}
                      {r && r !== "running" && r.answer ? (
                        <details className="mt-1 text-sm">
                          <summary className="cursor-pointer faint">See the answer</summary>
                          <p className="mt-1 whitespace-pre-wrap break-words muted">{r.answer}</p>
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
      </section>

      <div className="mt-5 flex justify-end">
        <button type="button" className={finished ? "btn btn-primary btn-lg" : "btn btn-quiet btn-lg"} onClick={finish}>
          {finished ? "Finish" : "Finish without waiting"}
        </button>
      </div>
    </div>
  );
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
