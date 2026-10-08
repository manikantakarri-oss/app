"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  api,
  DesignerBuilt,
  DesignerConnection,
  DesignerDraft,
  DesignerFile,
  DesignerInfo,
  DesignerMessage,
  DesignerModels,
  DesignerStep,
} from "@/lib/api";
import { chosen, loadChoice, NO_CHOICE, saveChoice } from "@/lib/designerModels";
import { ErrorBox, Spinner, Tag } from "./bits";
import { Finished } from "./BuilderParts";
import { ChevronLeftIcon, RefreshIcon } from "./icons";
import { Built } from "./designer/Built";
import { ConnectDialog } from "./designer/Connect";
import { Conversation } from "./designer/Conversation";
import { CreateStep, Creating } from "./designer/Creating";
import { ModelMenu } from "./designer/ModelPicker";
import { keepSaved, loadSaved, Phase, sleep, StageBar } from "./designer/parts";
import { ReviewTools } from "./designer/ReviewTools";
import { ToolCheck } from "./designer/ToolCheck";
import { ctaLabel, ProgressStrip, Summary } from "./designer/Summary";

/** Describe an assistant in plain words (beta).
 *
 *  Four stages, always shown: Describe (a short interview fills in a draft, seen beside
 *  it), Review (only when the assistant needs new tools: read them first), Create (the
 *  tools, then the assistant), Test (it is tried with a few questions). Nothing is
 *  created before the admin presses a button that says so.
 *
 *  The server keeps no session, so this holds the conversation and the draft and sends
 *  both each turn (also kept in sessionStorage so a refresh does not lose them). Which
 *  AI model does the work is the admin's choice, remembered in their own browser. */

const START: DesignerStep[] = [
  { key: "purpose", label: "What it is for", done: false },
  { key: "uses", label: "What it uses", done: false },
  { key: "behave", label: "How it should behave", done: false },
  { key: "access", label: "Who can use it", done: false },
];

export function Designer({ onCancel, onFinished }: { onCancel: () => void; onFinished: (d: Finished) => void }) {
  const [info, setInfo] = useState<DesignerInfo | null>(null);
  const [infoErr, setInfoErr] = useState("");
  const [choice, setChoice] = useState<DesignerModels>(NO_CHOICE);
  const [panel, setPanel] = useState(false);
  const [used, setUsed] = useState<DesignerModels | null>(null);
  const [notice, setNotice] = useState("");
  // A model that did not look at the workspace: shown once per model, until dismissed.
  const [warning, setWarning] = useState("");
  // On a wide screen the chat and the summary fill the window to the same height and
  // scroll inside themselves, so the box you type in and the Approve button stay in view.
  const work = useRef<HTMLDivElement>(null);
  const [fill, setFill] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = work.current;
    if (!el) return;
    const wide = window.matchMedia("(min-width: 1024px)");
    const place = () => {
      if (!wide.matches) return setFill(null);
      const top = el.getBoundingClientRect().top + window.scrollY;
      setFill(Math.max(520, Math.round(window.innerHeight - top - 24)));
    };
    place();
    window.addEventListener("resize", place);
    wide.addEventListener("change", place);
    return () => {
      window.removeEventListener("resize", place);
      wide.removeEventListener("change", place);
    };
  });
  const warned = useRef<string>("");
  // The interview was picked up from an earlier visit rather than started now.
  const [resumed, setResumed] = useState(false);

  const [msgs, setMsgs] = useState<DesignerMessage[]>([]);
  const [draft, setDraft] = useState<DesignerDraft>({});
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState<DesignerStep[]>(START);
  const [multiple, setMultiple] = useState(false);
  // Which credentials the design needs are set (names only; values never come to this page).
  const [connStatus, setConnStatus] = useState<Record<string, boolean>>({});
  const [connecting, setConnecting] = useState<DesignerConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [phase, setPhase] = useState<Phase>("describe");
  const [building, setBuilding] = useState(false);
  const [buildErr, setBuildErr] = useState("");
  const [steps, setSteps] = useState<CreateStep[]>([]);
  const [createErr, setCreateErr] = useState("");
  const [built, setBuilt] = useState<{ result: DesignerBuilt; draft: DesignerDraft } | null>(null);

  const started = useRef(false);
  const alive = useRef(true);
  const approved = useRef<string[]>([]); // what the admin ticked, so a retry never skips the review
  // New tools to try on real files before the assistant is built, one after another.
  const [checking, setChecking] = useState<{ tools: { slug: string; name: string }[]; at: number } | null>(null);
  const toBuild = useRef<DesignerDraft>({});

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    api
      .designerStatus()
      .then((i) => {
        setInfo(i);
        setChoice(loadChoice(i.models));
      })
      .catch((e: any) => setInfoErr(e.message));
  }, []);

  function changeChoice(c: DesignerModels) {
    setChoice(c);
    saveChoice(c);
  }

  // Pick up where a refresh left off, or open the interview, once we know a model is available.
  useEffect(() => {
    if (!info?.ready || started.current) return;
    started.current = true;
    const s = loadSaved();
    if (s && s.msgs.length) {
      setMsgs(s.msgs);
      setDraft(s.draft);
      setReady(s.ready);
      setMultiple(s.multiple);
      setProgress(s.progress?.length ? s.progress : START);
      setResumed(true);
    } else {
      run([], {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

  async function run(next: DesignerMessage[], from: DesignerDraft = draft) {
    setBusy(true);
    setErr("");
    try {
      const t = await api.designerTurn(next, from, chosen(choice));
      const all: DesignerMessage[] = [...next, { role: "assistant", content: t.reply, options: t.options, looked: t.looked }];
      setMsgs(all);
      setDraft(t.draft);
      setReady(t.ready);
      setMultiple(t.multiple);
      setProgress(t.progress);
      setUsed(t.models);
      setConnStatus(t.connections || {});
      setNotice(t.notice || "");
      if (t.warning && warned.current !== t.models.chat) {
        warned.current = t.models.chat; // once per model, not after every answer
        setWarning(t.warning);
      } else if (!t.warning) {
        setWarning("");
      }
      if (t.notice) {
        // The list on screen was loaded before the model failed: reload it so a retired model is not offered.
        api.designerStatus().then(setInfo).catch(() => {});
        // A model was swapped (for example one Databricks retired): stop remembering the one that failed.
        const kept = { ...choice };
        (["chat", "code", "judge"] as const).forEach((r) => {
          if (kept[r] && t.models[r] !== kept[r]) kept[r] = "";
        });
        if (kept.chat !== choice.chat || kept.code !== choice.code || kept.judge !== choice.judge) changeChoice(kept);
      }
      keepSaved({ msgs: all, draft: t.draft, ready: t.ready, multiple: t.multiple, progress: t.progress });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  function send(text: string, files?: DesignerFile[]) {
    const next: DesignerMessage[] = [...msgs, { role: "user", content: text, ...(files?.length ? { files } : {}) }];
    setMsgs(next);
    setReady(false);
    run(next);
  }

  function startOver() {
    keepSaved(null);
    setMsgs([]);
    setDraft({});
    setReady(false);
    setProgress(START);
    setConnStatus({});
    setNotice("");
    setWarning("");
    warned.current = "";
    setResumed(false);
    run([], {});
  }

  /** Create any new tools, wait until they work, then build the assistant. The same path
   *  serves an assistant with no new tools (it is just the last step). */
  async function createAndBuild(ticked: string[]) {
    approved.current = ticked;
    setPhase("create");
    setBuilding(true);
    setCreateErr("");
    setBuildErr("");
    let d = draft;
    const news = d.new_tools || [];
    const build: CreateStep = { label: "Build the assistant", state: "wait" };
    try {
      if (news.length) {
        const noun = news.length === 1 ? "the new tool" : "the new tools";
        setSteps([{ label: `Create ${noun}`, state: "work" }, build]);
        const { results } = await api.designerToolsCreate(d, ticked);
        // A function that exists now is an ordinary tool of the assistant, which also means
        // a retry never tries to create it a second time.
        const made = results.filter((r) => r.kind === "uc_function" && r.created).map((r) => r.key);
        const nowTools = news
          .filter((n) => n.kind === "uc_function" && made.includes(n.name))
          .map((n) => ({ type: "uc_function", ref: n.name, description: n.description }));
        d = { ...d, tools: [...(d.tools || []), ...nowTools], new_tools: news.filter((n) => !(n.kind === "uc_function" && made.includes(n.name))) };
        setDraft(d);
        keepSaved({ msgs, draft: d, ready, multiple, progress });
        const apps = results.filter((r) => r.kind === "mcp" && r.app_name).map((r) => r.app_name as string);
        let up = apps.length === 0;
        for (let i = 0; i < 300 && alive.current; i++) {
          const st = apps.length ? (await api.designerToolsStatus(apps)).apps : {};
          const bad = apps.find((a) => st[a]?.state === "failed");
          if (bad) throw new Error(`The new tool could not be installed: ${st[bad].note || "no reason was given"}`);
          up = apps.every((a) => st[a]?.state === "running");
          setSteps([
            ...made.map((m): CreateStep => ({ label: `Created the function ${m}`, state: "done" })),
            ...apps.map((a): CreateStep => ({
              label: st[a]?.state === "running" ? `${a.replace(/^mcp-/, "")} is ready` : `Getting ${a.replace(/^mcp-/, "")} ready`,
              state: st[a]?.state === "running" ? "done" : "work",
              note: st[a]?.state === "running" ? undefined : st[a]?.note || "This takes a few minutes.",
            })),
            { ...build, state: up ? "work" : "wait" },
          ]);
          if (up) break;
          await sleep(6000);
        }
        if (!alive.current) return;
        if (!up) throw new Error("A new tool did not start within about 30 minutes. Try again in a while.");
      } else {
        setSteps([{ ...build, state: "work" }]);
      }
      // New tools are running. Try them on the real files in their folders before an assistant is built
      // around them: a tool that passed every automatic check can still fail on the first real file.
      const toTry = (d.new_tools || []).filter((n) => n.kind === "mcp" && n.slug).map((n) => ({ slug: n.slug as string, name: n.name }));
      if (toTry.length) {
        toBuild.current = d;
        setChecking({ tools: toTry, at: 0 });
        return;
      }
      await buildNow(d);
    } catch (e: any) {
      // Mark the step that was in progress as the one that failed.
      setSteps((prev) => {
        const at = prev.findIndex((s) => s.state === "work");
        return prev.map((s, i) => (i === (at >= 0 ? at : prev.length - 1) ? { ...s, state: "fail" } : s));
      });
      setCreateErr(e.message);
    } finally {
      setBuilding(false);
    }
  }

  /** Build the assistant. Tools that have been created and tried are ordinary installed tools from here on,
   *  so a retry never installs them again. */
  async function buildNow(d0: DesignerDraft) {
    setChecking(null);
    setPhase("create");
    setBuilding(true);
    setCreateErr("");
    const madeApps = (d0.new_tools || []).filter((n) => n.kind === "mcp" && n.slug);
    const d: DesignerDraft = {
      ...d0,
      tools: [...(d0.tools || []), ...madeApps.map((n) => ({ type: "app", ref: `mcp-${n.slug}`, description: n.description }))],
      new_tools: (d0.new_tools || []).filter((n) => !(n.kind === "mcp" && n.slug)),
    };
    setDraft(d);
    keepSaved({ msgs, draft: d, ready, multiple, progress });
    setSteps([
      ...(d0.new_tools?.length ? [{ label: "Created and tried the new tools", state: "done" } as CreateStep] : []),
      { label: "Build the assistant", state: "work" },
    ]);
    try {
      const result = await api.designerBuild(d);
      if (!alive.current) return;
      keepSaved(null);
      setBuilt({ result, draft: d });
      setPhase("test");
    } catch (e: any) {
      setSteps((prev) => prev.map((s, i) => (i === prev.length - 1 ? { ...s, state: "fail" } : s)));
      setCreateErr(e.message);
    } finally {
      setBuilding(false);
    }
  }

  const approve = () => (draft.new_tools?.length ? setPhase("review") : createAndBuild([]));
  const retry = () => {
    const left = (draft.new_tools || []).map((n) => n.fingerprint);
    // What was approved still stands for what is left; anything not approved goes back through the review.
    if (left.every((fp) => approved.current.includes(fp))) createAndBuild(left);
    else setPhase("review");
  };

  const hasUser = msgs.some((m) => m.role === "user");
  const body = (() => {
    if (infoErr) return <ErrorBox>{infoErr}</ErrorBox>;
    if (!info) return <Spinner label="Getting things ready…" />;
    if (!info.ready) {
      return (
        <div className="card max-w-2xl p-6">
          <h3 className="text-[16px] font-semibold">There is no AI model for you to use yet</h3>
          <p className="mt-1 text-[15px] muted">{info.reason}</p>
          <button type="button" className="btn btn-quiet mt-4" onClick={onCancel}>
            ← Back
          </button>
        </div>
      );
    }
    if (phase === "review") {
      return <ReviewTools tools={draft.new_tools || []} onBack={() => setPhase("describe")} onCreate={createAndBuild} />;
    }
    if (phase === "create" && checking) {
      const t = checking.tools[checking.at];
      return (
        <ToolCheck
          key={t.slug}
          slug={t.slug}
          name={t.name}
          models={chosen(choice)}
          onBack={() => {
            setChecking(null);
            setPhase("describe");
          }}
          onDone={() => (checking.at + 1 < checking.tools.length ? setChecking({ ...checking, at: checking.at + 1 }) : buildNow(toBuild.current))}
        />
      );
    }
    if (phase === "create") {
      return <Creating steps={steps} error={createErr} onRetry={retry} onBack={() => setPhase("describe")} />;
    }
    if (phase === "test" && built) {
      return <Built built={built} models={chosen(choice)} onFinished={onFinished} />;
    }
    return (
      <>
        {resumed ? (
          <div className="notice mb-3 flex flex-wrap items-center justify-between gap-3" role="status">
            <span>We picked up the conversation you started earlier.</span>
            <span className="flex gap-3 text-sm font-medium">
              <button type="button" className="underline" onClick={startOver} disabled={busy || building}>
                Start over
              </button>
              <button type="button" className="underline" onClick={() => setResumed(false)}>
                Dismiss
              </button>
            </span>
          </div>
        ) : null}
        {warning ? (
          <div className="notice mb-3 flex flex-wrap items-center justify-between gap-3" role="status">
            <span>{warning}</span>
            <span className="flex gap-3 text-sm font-medium">
              <button type="button" className="underline" onClick={() => { setPanel(true); setWarning(""); }}>
                Choose a model
              </button>
              <button type="button" className="underline" onClick={() => setWarning("")}>
                Dismiss
              </button>
            </span>
          </div>
        ) : null}
        {notice ? (
          <div className="notice mb-3 flex items-start justify-between gap-3" role="status">
            <span>{notice}</span>
            <button type="button" className="shrink-0 text-sm font-medium underline" onClick={() => setNotice("")}>
              Dismiss
            </button>
          </div>
        ) : null}
        {hasUser ? <ProgressStrip progress={progress} /> : null}
        <div ref={work} className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]" style={fill ? { height: fill } : undefined}>
          <Conversation
            msgs={msgs}
            busy={busy}
            err={err}
            multiple={multiple}
            ready={ready}
            actionLabel={ctaLabel(draft)}
            building={building}
            connections={draft.connections || []}
            connStatus={connStatus}
            onSend={send}
            onRetry={() => run(msgs)}
            onApprove={approve}
            onConnect={setConnecting}
          />
          <Summary
            draft={draft}
            progress={progress}
            ready={ready}
            building={building}
            busy={busy}
            error={buildErr}
            onApprove={approve}
            connStatus={connStatus}
            onConnect={setConnecting}
          />
          {connecting ? (
            <ConnectDialog
              c={connecting}
              connected={!!connStatus[connecting.name]}
              onClose={() => setConnecting(null)}
              onSaved={(c) => {
                setConnecting(null);
                setConnStatus((s) => ({ ...s, [c.name]: true }));
                // Say so in the conversation (names only), so the designer carries on without being told.
                if (!busy) send(`I have connected ${c.label}.`);
              }}
            />
          ) : null}
        </div>
      </>
    );
  })();

  return (
    <div className="w-full">
      <header className="mb-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {phase === "describe" ? (
            <button type="button" className="btn btn-quiet !px-3" onClick={onCancel} aria-label="Cancel and go back">
              <ChevronLeftIcon size={16} />
              <span className="hidden sm:inline">Cancel</span>
            </button>
          ) : null}
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h2 className="text-xl font-semibold tracking-tight sm:text-[22px]">New assistant</h2>
              <Tag title="A new way to build that is still being tested. Everything is shown to you before it is created.">Beta</Tag>
            </div>
            <p className="mt-0.5 hidden text-[13.5px] muted sm:block">Built from a short conversation. Nothing is created until you approve it.</p>
          </div>
          {phase === "describe" && info?.ready ? (
            <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
              <ModelMenu info={info} choice={choice} used={used} onChange={changeChoice} open={panel} setOpen={setPanel} />
              {hasUser ? (
                <button type="button" className="btn btn-quiet" onClick={startOver} disabled={busy || building} title="Clear the conversation and start again">
                  <RefreshIcon size={15} /> <span className="hidden sm:inline">Start over</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="mt-5 overflow-x-auto">
          <StageBar phase={phase} />
        </div>
      </header>
      {body}
    </div>
  );
}
