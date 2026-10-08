"use client";

import { DragEvent, ReactNode, useEffect, useRef, useState } from "react";
import { designerAttach, designerDetach, DesignerConnection, DesignerFile, DesignerMessage } from "@/lib/api";
import { ErrorBox } from "../bits";
import { ArrowUpIcon, BookIcon, ChartIcon, CheckIcon, PaperclipIcon, RefreshIcon, ShieldIcon, WandIcon } from "../icons";
import { ACCEPT, AttachChips, describeFiles, FolderDialog, loadFolder, MAX_BYTES, MAX_FILES, Pending, saveFolder } from "./Files";
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

const TYPES = new Set(ACCEPT.split(",").map((x) => x.slice(1)));

/** What it says while it works: honest about time, so a slow turn is not mistaken for a stuck one. */
function working(seconds: number): string {
  if (seconds < 6) return "Thinking…";
  if (seconds < 25) return "Looking things up in your workspace…";
  return "Still looking. Checking your workspace can take a little while…";
}

let seq = 0;

export function Conversation({
  msgs,
  busy,
  err,
  multiple,
  ready,
  actionLabel,
  building,
  connections,
  connStatus,
  writing = [],
  onSend,
  onRetry,
  onApprove,
  onConnect,
}: {
  msgs: DesignerMessage[];
  busy: boolean;
  err: string;
  multiple: boolean;
  ready: boolean;
  actionLabel: string;
  building: boolean;
  connections: DesignerConnection[];
  connStatus: Record<string, boolean>;
  /** New tools being written in the background, with where each is up to. */
  writing?: { name: string; step: string; seconds: number }[];
  onSend: (text: string, files?: DesignerFile[]) => void;
  onRetry: () => void;
  onApprove: () => void;
  onConnect: (c: DesignerConnection) => void;
}) {
  const [input, setInput] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [changing, setChanging] = useState(false);
  const [seconds, setSeconds] = useState(0);
  // Typed on the welcome screen before the opening question arrived: sent the moment it does.
  const [queued, setQueued] = useState<{ text: string; files: DesignerFile[] } | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [folder, setFolder] = useState("");
  const [askFolder, setAskFolder] = useState<File[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => setFolder(loadFolder()), []);

  const last = msgs[msgs.length - 1];
  const options = !busy && last?.role === "assistant" ? last.options || [] : [];
  // Nothing typed yet: the welcome screen.
  const fresh = !msgs.some((m) => m.role === "user");
  const showReady = ready && !busy && last?.role === "assistant";
  const unconnected = connections.filter((c) => !connStatus[c.name]);
  const uploading = pending.some((p) => p.state === "uploading");
  const ready_files = pending.filter((p) => p.state === "done" && p.done).map((p) => p.done as DesignerFile);

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
    setQueued(null);
    onSend(q.text, q.files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queued]);

  // --- attaching ---------------------------------------------------------------

  async function upload(p: Pending, to: string, how: "ask" | "replace" | "keep_both" = "ask") {
    setPending((all) => all.map((x) => (x.id === p.id ? { ...x, state: "uploading", error: undefined } : x)));
    const r = await designerAttach(p.file, to, how);
    setPending((all) =>
      all.map((x) =>
        x.id !== p.id
          ? x
          : r.ok
            ? { ...x, state: "done", done: r.file }
            : { ...x, state: r.conflict ? "conflict" : "error", error: r.error }
      )
    );
  }

  function attach(list: File[], to = folder) {
    if (!list.length) return;
    if (!to) {
      setAskFolder(list);
      return;
    }
    const room = Math.max(0, MAX_FILES - pending.length);
    const items: Pending[] = list.map((file) => {
      const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
      const id = `f${++seq}`;
      if (!TYPES.has(ext)) return { id, file, state: "error", error: "Only documents and data files can be attached (Excel, CSV, PDF, Word, PowerPoint, text)." };
      if (file.size > MAX_BYTES) return { id, file, state: "error", error: "Larger than the 100 MB limit." };
      if (!file.size) return { id, file, state: "error", error: "This file is empty." };
      return { id, file, state: "uploading" };
    });
    const keep = items.slice(0, room);
    const over = items.slice(room).map((p): Pending => ({ ...p, state: "error", error: `Up to ${MAX_FILES} files per message.` }));
    setPending((all) => [...all, ...keep, ...over]);
    keep.filter((p) => p.state === "uploading").forEach((p) => upload(p, to));
  }

  function remove(p: Pending) {
    setPending((all) => all.filter((x) => x.id !== p.id));
    if (p.done) designerDetach(p.done.path).catch(() => {});
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (locked) return;
    attach(Array.from(e.dataTransfer.files || []));
  }

  // --- sending -----------------------------------------------------------------

  function send(text: string) {
    const t = text.trim();
    const files = ready_files;
    if ((!t && !files.length) || building || uploading) return;
    const words = t || (files.length === 1 ? "Here is the file." : "Here are the files.");
    const content = files.length ? `${words}\n\n${describeFiles(files)}` : words;
    if (busy) {
      if (!fresh || queued) return;
      setQueued({ text: content, files }); // the opening question is still loading: hold it, never lose it
    } else {
      onSend(content, files);
    }
    setInput("");
    setPending((all) => all.filter((p) => p.state !== "done"));
    if (box.current) box.current.style.height = "";
    setChanging(false);
  }

  // On the welcome screen you can type while it gets ready; in the conversation you wait for the reply.
  const locked = building || (busy && !fresh) || !!queued;
  const canSend = !locked && !uploading && (!!input.trim() || ready_files.length > 0);

  const composer = (large: boolean) => (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send(input);
      }}
    >
      <AttachChips items={pending} onRemove={remove} onResolve={(p, how) => upload(p, folder, how)} />
      <div className={large ? "dz-composer dz-composer-lg dz-has-attach" : "dz-composer dz-has-attach"} data-disabled={locked ? "true" : "false"}>
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
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files || []);
            if (files.length) {
              e.preventDefault();
              attach(files);
            }
          }}
        />
        <button
          type="button"
          className="dz-attach"
          onClick={() => picker.current?.click()}
          disabled={locked || pending.length >= MAX_FILES}
          aria-label="Attach a file"
          title="Attach a file (Excel, CSV, PDF, Word, PowerPoint, text)"
        >
          <PaperclipIcon size={17} />
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            attach(Array.from(e.target.files || []));
            e.target.value = "";
          }}
        />
        <button type="submit" className="dz-send" disabled={!canSend} aria-label="Send">
          <ArrowUpIcon size={17} />
        </button>
      </div>
      {large || pending.length ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[12px] faint">
          {large ? (
            <p className="hidden items-center gap-1.5 sm:flex">
              <span className="dz-kbd">Enter</span> to send <span className="mx-1">·</span> <span className="dz-kbd">Shift</span>+
              <span className="dz-kbd">Enter</span> for a new line
            </p>
          ) : null}
          {folder ? (
            <p className="min-w-0 truncate">
              Files go to <span className="font-mono">{folder}</span> ·{" "}
              <button type="button" className="underline" onClick={() => setAskFolder([])}>
                change
              </button>
            </p>
          ) : (
            <p>Attach an ad book, rate card or policy to design around it.</p>
          )}
        </div>
      ) : null}
    </form>
  );

  const dropZone = {
    onDragOver: (e: DragEvent) => {
      if (Array.from(e.dataTransfer.types || []).includes("Files")) {
        e.preventDefault();
        setDragging(true);
      }
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
    },
    onDrop,
  };
  const dropOverlay = dragging ? (
    <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-2xl text-[15px] font-semibold"
      style={{ border: "2px dashed var(--brand)", background: "color-mix(in srgb, var(--brand-soft) 85%, transparent)", color: "var(--brand-deep)" }}>
      Drop files to attach them
    </div>
  ) : null;
  const folderDialog = askFolder ? (
    <FolderDialog
      initial={folder}
      onClose={() => setAskFolder(null)}
      onSave={(f) => {
        saveFolder(f);
        setFolder(f);
        const waiting = askFolder;
        setAskFolder(null);
        attach(waiting, f);
      }}
    />
  ) : null;

  if (fresh) {
    return (
      <section className="card relative flex min-h-[420px] flex-col overflow-y-auto p-0 lg:min-h-0" aria-label="Conversation" {...dropZone}>
        {dropOverlay}
        {folderDialog}
        <div className="m-auto w-full max-w-[720px] px-5 py-8 sm:px-8">
          <div className="flex flex-col items-center text-center">
            <Mark large />
            <h3 className="dz-hero-title mt-5">What should your new assistant do?</h3>
            <p className="mt-2 max-w-[560px] text-[15px] muted">
              Describe it in your own words: what it should help with and who will use it. Attach any file it should work from. We ask a
              few short questions, show you what we understood, and create nothing until you say so.
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
              <button key={s.text} type="button" className="dz-starter" disabled={locked || uploading} onClick={() => send(s.text)}>
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
    <section className="card relative flex min-h-[420px] flex-col p-0 lg:min-h-0" aria-label="Conversation" {...dropZone}>
      {dropOverlay}
      {folderDialog}
      <div
        ref={scroller}
        className="relative max-h-[calc(100dvh-var(--header-h,56px)-300px)] min-h-[300px] flex-1 overflow-y-auto px-5 py-6 sm:px-7 lg:max-h-none lg:min-h-0"
        aria-live="polite"
      >
        <div className="mx-auto w-full max-w-[860px] space-y-6">
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
      </div>

      <div className="shrink-0 border-t px-4 pb-3 pt-3 sm:px-6" style={{ borderColor: "var(--line)" }}>
      <div className="mx-auto w-full max-w-[860px]">
        {writing.map((w) => (
          <div
            key={w.name}
            className="mb-2.5 flex items-center gap-3 rounded-[12px] px-3 py-2 text-[13.5px]"
            style={{ background: "var(--brand-soft)", border: "1px solid color-mix(in srgb, var(--brand) 35%, transparent)" }}
            role="status"
          >
            <span className="dz-spin shrink-0" style={{ color: "var(--brand-deep)" }} aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              <b>Writing the new tool {w.name}</b> <span className="muted">· {w.step}</span>
            </span>
            <span className="shrink-0 tabular-nums faint" title="Usually 2 to 5 minutes. You can keep answering meanwhile.">
              {Math.floor(w.seconds / 60)}:{String(w.seconds % 60).padStart(2, "0")}
            </span>
          </div>
        ))}
        {unconnected.length && !busy ? (
          <div
            className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] px-3 py-2"
            style={{ background: "var(--warn-bg)", border: "1px solid color-mix(in srgb, var(--warn-line) 55%, transparent)" }}
          >
            <span aria-hidden style={{ color: "var(--warn-line)" }}>
              <ShieldIcon size={16} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13.5px]" title={unconnected.map((c) => c.what_for).filter(Boolean).join(" ")}>
              <b>{unconnected.length === 1 ? "One connection needed" : `${unconnected.length} connections needed`}</b>
              <span className="muted"> · kept in your workspace&apos;s secret store, never shown to the AI</span>
            </span>
            <span className="flex flex-wrap gap-1.5">
              {unconnected.map((c) => (
                <button key={c.name} type="button" className="btn btn-primary !min-h-0 !px-3 !py-1 text-[13px]" onClick={() => onConnect(c)}>
                  Connect {c.label}
                </button>
              ))}
            </span>
          </div>
        ) : null}

        {showReady && !changing ? (
          <div className="dz-ready mb-2.5 !py-2.5">
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
          <div className="dz-answers mb-2.5 flex flex-wrap items-center gap-2" role="group" aria-label="Quick answers">
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
      </div>
    </section>
  );
}
