"use client";

import { ReactNode, useEffect, useRef, useState } from "react";
import type { DesignerMessage } from "@/lib/api";
import { ErrorBox } from "../bits";
import { ArrowUpIcon, BookIcon, ChartIcon, CheckIcon, RefreshIcon, WandIcon } from "../icons";
import { Bubble, Mark } from "./parts";

/** Starting points for someone who does not know what to type. They only nudge the
 *  wording: the designer still works out the kind of assistant itself. The example
 *  under each says what people would then ask it, which is easier to picture than a
 *  category. */
const STARTERS: { text: string; example: string; icon: ReactNode }[] = [
  { text: "Answer questions about our data", example: "“What were sales by region last month?”", icon: <ChartIcon size={18} /> },
  { text: "Answer questions from our documents", example: "“What does our travel policy say about flights?”", icon: <BookIcon size={18} /> },
  { text: "Do a task using our tools and files", example: "“Turn this brief into a media plan and export it.”", icon: <WandIcon size={18} /> },
];

/** What it says while it works: honest about time, so a slow turn is not mistaken for a stuck one. */
function working(seconds: number): string {
  if (seconds < 6) return "Thinking…";
  if (seconds < 25) return "Looking things up in your workspace…";
  return "Still looking. Checking your workspace can take a little while…";
}

export function Conversation({
  msgs,
  busy,
  err,
  multiple,
  ready,
  actionLabel,
  building,
  onSend,
  onRetry,
  onApprove,
}: {
  msgs: DesignerMessage[];
  busy: boolean;
  err: string;
  multiple: boolean;
  ready: boolean;
  actionLabel: string;
  building: boolean;
  onSend: (text: string) => void;
  onRetry: () => void;
  onApprove: () => void;
}) {
  const [input, setInput] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [changing, setChanging] = useState(false);
  const [seconds, setSeconds] = useState(0);
  // Typed on the welcome screen before the opening question arrived: sent the moment it does.
  const [queued, setQueued] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const last = msgs[msgs.length - 1];
  const options = !busy && last?.role === "assistant" ? last.options || [] : [];
  // Nothing typed yet: the welcome screen, with the opening question as its heading.
  const fresh = !msgs.some((m) => m.role === "user");
  const showReady = ready && !busy && last?.role === "assistant";

  useEffect(() => {
    if (!busy) return;
    setSeconds(0);
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [msgs.length, busy]);

  // After each reply the cursor is ready for the answer, unless there are buttons to press. Only with
  // a mouse and keyboard: on a phone, focusing opens the on-screen keyboard and scrolls the page uninvited.
  useEffect(() => {
    setPicked([]);
    const precise = typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches;
    if (precise && !busy && last?.role === "assistant" && !options.length) box.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs.length, busy]);

  useEffect(() => {
    if (busy || !queued) return;
    const q = queued;
    setQueued("");
    onSend(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queued]);

  function send(text: string) {
    const t = text.trim();
    if (!t || building) return;
    if (busy) {
      if (!fresh || queued) return;
      setQueued(t); // the opening question is still loading: hold it, never lose it
    } else {
      onSend(t);
    }
    setInput("");
    if (box.current) box.current.style.height = "";
    setChanging(false);
  }

  // On the welcome screen you can type while it gets ready; in the conversation you wait for the reply.
  const locked = building || (busy && !fresh) || !!queued;

  const composer = (large: boolean) => (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send(input);
      }}
    >
      <div className={large ? "dz-composer dz-composer-lg" : "dz-composer"} data-disabled={locked ? "true" : "false"}>
        <textarea
          ref={box}
          rows={1}
          value={input}
          disabled={locked}
          placeholder={
            queued
              ? "Sending as soon as it is ready…"
              : changing
                ? "What would you like to change?"
                : options.length
                  ? "Or type your own answer…"
                  : fresh
                    ? "For example: a media planner for our sales team that turns an advertiser’s budget and dates into a plan…"
                    : "Type your answer…"
          }
          aria-label="Your answer"
          onChange={(e) => {
            setInput(e.target.value);
            // Grow with what is typed (up to about eight lines), then scroll.
            const t = e.target;
            t.style.height = "auto";
            t.style.height = Math.min(t.scrollHeight + 2, 220) + "px";
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        <button type="submit" className="dz-send" disabled={locked || !input.trim()} aria-label="Send">
          <ArrowUpIcon size={17} />
        </button>
      </div>
      <p className="mt-2 hidden items-center gap-1.5 text-[12px] faint sm:flex">
        <span className="dz-kbd">Enter</span> to send <span className="mx-1">·</span> <span className="dz-kbd">Shift</span>+
        <span className="dz-kbd">Enter</span> for a new line
      </p>
    </form>
  );

  if (fresh) {
    return (
      <section className="card flex min-h-[420px] flex-col overflow-y-auto p-0 lg:min-h-0" aria-label="Conversation">
        <div className="m-auto w-full max-w-[720px] px-5 py-8 sm:px-8">
          <div className="flex flex-col items-center text-center">
            <Mark large />
            <h3 className="dz-hero-title mt-5">What should your new assistant do?</h3>
            <p className="mt-2 max-w-[560px] text-[15px] muted">
              Describe it in your own words: what it should help with and who will use it. We ask a few short questions, show you what we
              understood, and create nothing until you say so.
            </p>
          </div>
          <div className="mt-7">{composer(true)}</div>
          {queued ? (
            <p className="mt-3 flex items-center gap-2 text-[13.5px]" role="status">
              <span className="dz-spin" style={{ color: "var(--brand-deep)" }} aria-hidden />
              <span className="dz-shimmer font-medium">Getting ready. Your message goes the moment we are.</span>
            </p>
          ) : null}
          <p className="dz-eyebrow mt-7">Or start from one of these</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {STARTERS.map((s) => (
              <button key={s.text} type="button" className="dz-starter" disabled={locked} onClick={() => send(s.text)}>
                <span className="dz-tile">{s.icon}</span>
                <span className="text-[14.5px] font-semibold leading-snug">{s.text}</span>
                <span className="text-[13px] leading-snug faint">{s.example}</span>
              </button>
            ))}
          </div>
          {err ? (
            <div className="mt-5">
              <ErrorBox>{err}</ErrorBox>
              <button type="button" className="btn btn-quiet mt-2" onClick={onRetry}>
                <RefreshIcon size={15} /> Try that again
              </button>
            </div>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className="card flex min-h-[420px] flex-col p-0 lg:min-h-0" aria-label="Conversation">
      <div
        ref={scroller}
        className="max-h-[calc(100dvh-var(--header-h,56px)-300px)] min-h-[300px] flex-1 space-y-6 overflow-y-auto px-5 py-6 sm:px-7 lg:max-h-none lg:min-h-0"
        aria-live="polite"
      >
        {msgs.map((m, i) => (
          <Bubble key={i} m={m} />
        ))}

        {busy ? (
          <div className="flex gap-3" role="status" aria-label="Working on it">
            <Mark />
            <div className="flex items-center gap-2 pt-1.5 text-[14.5px]">
              <span className="dz-shimmer font-medium">{working(seconds)}</span>
              {seconds >= 6 ? <span className="text-[12.5px] tabular-nums faint">{seconds}s</span> : null}
            </div>
          </div>
        ) : null}

        {err ? (
          <div className="pl-11">
            <ErrorBox>{err}</ErrorBox>
            <button type="button" className="btn btn-quiet mt-2" onClick={onRetry}>
              <RefreshIcon size={15} /> Try that again
            </button>
          </div>
        ) : null}
      </div>

      <div className="border-t px-4 pb-4 pt-3 sm:px-6" style={{ borderColor: "var(--line)" }}>
        {showReady && !changing ? (
          <div className="dz-ready mb-3">
            <span className="flex min-w-0 flex-1 items-center gap-2 text-[14.5px] font-medium">
              <span aria-hidden style={{ color: "var(--ok)" }}>
                <CheckIcon size={18} />
              </span>
              Everything is settled. Check the summary, then build it.
            </span>
            <span className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setChanging(true);
                  box.current?.focus();
                }}
              >
                Change something
              </button>
              <button type="button" className="btn btn-primary" disabled={building} onClick={onApprove}>
                {actionLabel}
              </button>
            </span>
          </div>
        ) : null}

        {options.length ? (
          <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Quick answers">
            {options.map((o) => {
              const on = picked.includes(o);
              return (
                <button
                  key={o}
                  type="button"
                  className="dz-chip"
                  aria-pressed={multiple ? on : false}
                  onClick={() => (multiple ? setPicked(on ? picked.filter((x) => x !== o) : [...picked, o]) : send(o))}
                >
                  {multiple && on ? <CheckIcon size={14} /> : null}
                  {o}
                </button>
              );
            })}
            {multiple ? (
              <button type="button" className="btn btn-primary !min-h-0 !py-[7px]" disabled={!picked.length} onClick={() => send(picked.join(", "))}>
                Send{picked.length ? ` ${picked.length}` : ""}
              </button>
            ) : null}
          </div>
        ) : null}

        {composer(false)}
      </div>
    </section>
  );
}
