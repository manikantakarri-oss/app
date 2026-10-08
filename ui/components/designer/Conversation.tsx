"use client";

import { useEffect, useRef, useState } from "react";
import type { DesignerMessage } from "@/lib/api";
import { ErrorBox } from "../bits";
import { ArrowUpIcon, RefreshIcon } from "../icons";
import { Bubble, Mark } from "./parts";

/** Starting points for someone who does not know what to type. They only nudge the
 *  wording: the designer still works out the kind of assistant itself. */
const STARTERS = [
  "Answer questions about our data",
  "Answer questions from our documents",
  "Do a task using our tools and files",
];

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
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const last = msgs[msgs.length - 1];
  const options = !busy && last?.role === "assistant" ? last.options || [] : [];
  const starting = !busy && msgs.length === 1 && last?.role === "assistant";
  const showReady = ready && !busy && last?.role === "assistant";

  // How long it has been working, so a slow turn is not mistaken for a stuck one.
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

  function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    setInput("");
    setChanging(false);
    onSend(t);
  }

  return (
    <section className="card flex min-h-[420px] flex-col p-0" aria-label="Conversation">
      <div ref={scroller} className="max-h-[calc(100dvh-var(--header-h,56px)-300px)] min-h-[300px] flex-1 space-y-4 overflow-y-auto p-5" aria-live="polite">
        {msgs.map((m, i) => (
          <Bubble key={i} m={m} />
        ))}

        {starting ? (
          <div className="pl-11">
            <p className="mb-2 text-[13px] faint">Not sure what to say? Start with one of these, or just type.</p>
            <div className="flex flex-wrap gap-2">
              {STARTERS.map((s) => (
                <button key={s} type="button" className="choice !w-auto !px-3.5 !py-2 text-[14.5px]" aria-pressed={false} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {busy ? (
          <div className="flex gap-3" role="status" aria-label="Working on it">
            <Mark />
            <div className="pt-1.5">
              <div className="flex items-center gap-1.5">
                <span className="typing-dot" />
                <span className="typing-dot" style={{ animationDelay: "0.15s" }} />
                <span className="typing-dot" style={{ animationDelay: "0.3s" }} />
              </div>
              <p className="mt-1.5 text-xs faint">
                {seconds < 6 ? "Thinking…" : seconds < 25 ? `Looking things up in your workspace… ${seconds}s` : `Still working. Looking things up can take a little while. ${seconds}s`}
              </p>
            </div>
          </div>
        ) : null}

        {err ? (
          <div>
            <ErrorBox>{err}</ErrorBox>
            <button type="button" className="btn btn-quiet mt-2" onClick={onRetry}>
              <RefreshIcon size={15} /> Try that again
            </button>
          </div>
        ) : null}
      </div>

      <div className="border-t p-4" style={{ borderColor: "var(--line)" }}>
        {showReady ? (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary" disabled={building} onClick={onApprove}>
              {actionLabel}
            </button>
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
          </div>
        ) : null}

        {options.length ? (
          <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Quick answers">
            {options.map((o) => {
              const on = picked.includes(o);
              return (
                <button
                  key={o}
                  type="button"
                  className="choice !w-auto !px-3.5 !py-2 text-[14.5px]"
                  aria-pressed={multiple ? on : false}
                  onClick={() => (multiple ? setPicked(on ? picked.filter((x) => x !== o) : [...picked, o]) : send(o))}
                >
                  {multiple && on ? "✓ " : ""}
                  {o}
                </button>
              );
            })}
            {multiple ? (
              <button type="button" className="btn btn-primary" disabled={!picked.length} onClick={() => send(picked.join(", "))}>
                Send {picked.length ? `(${picked.length})` : ""}
              </button>
            ) : null}
          </div>
        ) : null}

        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <textarea
            ref={box}
            className="field min-h-[44px] flex-1 resize-none"
            rows={2}
            value={input}
            disabled={busy || building}
            placeholder={changing ? "What would you like to change?" : options.length ? "Or type your own answer…" : msgs.length <= 1 ? "Describe what you want it to do…" : "Type your answer…"}
            aria-label="Your answer"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
          />
          <button type="submit" className="btn btn-primary h-11 w-11 !p-0" disabled={busy || building || !input.trim()} aria-label="Send">
            <ArrowUpIcon size={18} />
          </button>
        </form>
        <p className="help">Enter sends. Shift and Enter starts a new line.</p>
      </div>
    </section>
  );
}
