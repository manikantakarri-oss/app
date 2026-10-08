"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DesignerInfo, DesignerModel, DesignerModels } from "@/lib/api";
import { modelDetail, NO_CHOICE } from "@/lib/designerModels";
import { Select } from "../bits";
import { CheckIcon, ChevronDownIcon, SparkleIcon } from "../icons";

/** The AI model: one button in the header that opens a menu under it.
 *
 *  Picking a model is one click, so that is what the menu is: one row per model
 *  with what it is good at and a plain cost mark. The two specialist jobs
 *  (writing a new tool's code, marking the test answers) sit under "Advanced"
 *  with sensible automatic choices. Prices stay out of the way (in the cost
 *  mark's tooltip): the people here think in "cheap or not", not DBUs. */

export function modelName(info: DesignerInfo, name: string): string {
  return info.models.find((m) => m.name === name)?.label || name;
}

const COST: Record<string, { mark: string; word: string }> = {
  "Low cost": { mark: "$", word: "Low cost" },
  "Moderate cost": { mark: "$$", word: "Moderate cost" },
  "Higher cost": { mark: "$$$", word: "Higher cost" },
};

function CostMark({ m }: { m: DesignerModel }) {
  const c = COST[m.cost];
  if (!c) return null;
  const exact = m.price_in != null && m.price_out != null ? ` (${round(m.price_in)} in, ${round(m.price_out)} out, DBUs per million tokens)` : "";
  return (
    <span className="model-cost" title={c.word + exact} aria-label={c.word}>
      <span>{c.mark}</span>
      <span className="model-cost-rest" aria-hidden>
        {"$$$".slice(c.mark.length)}
      </span>
    </span>
  );
}

function round(n: number) {
  return n >= 10 ? Math.round(n).toString() : n.toFixed(1);
}

export function ModelMenu({
  info,
  choice,
  used,
  onChange,
  open,
  setOpen,
}: {
  info: DesignerInfo;
  choice: DesignerModels;
  /** What the last turn really used (after defaults), when known. */
  used: DesignerModels | null;
  onChange: (c: DesignerModels) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const id = useId();
  const [box, setBox] = useState<{ top: number; right: number; width: number; max: number } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const chat = choice.chat || info.defaults.chat;
  const picked = info.models.find((m) => m.name === chat);
  const set = (patch: Partial<DesignerModels>) => onChange({ ...choice, ...patch });
  const anyChoice = !!(choice.chat || choice.code || choice.judge);

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(440, window.innerWidth - 32);
    // Right edge under the button's right edge, kept inside the window.
    const right = Math.max(16, Math.min(window.innerWidth - r.right, window.innerWidth - width - 16));
    setBox({ top: r.bottom + 6, right, width, max: Math.max(260, window.innerHeight - r.bottom - 24) });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element;
      // Clicks in a dropdown of the Advanced section open in their own layer.
      if (btn.current?.contains(t) || pop.current?.contains(t) || t.closest?.(".select-pop")) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".select-pop")) {
        setOpen(false);
        btn.current?.focus();
      }
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, place, setOpen]);

  // Focus the chosen model when the menu opens, so arrow keys and Enter work at once.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => pop.current?.querySelector<HTMLButtonElement>('[aria-checked="true"], [role="menuitemradio"]:not(:disabled)')?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  function onListKey(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(pop.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') || []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  }

  const options = info.models.map((m) => ({ value: m.name, label: m.label, detail: modelDetail(m) }));
  const judgeNow = choice.judge || used?.judge || "";
  const sameChecker = judgeNow !== "" && judgeNow === chat;

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="btn btn-quiet"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        title="Choose which AI model does the thinking"
      >
        <SparkleIcon size={15} />
        <span className="hidden text-[13px] muted 2xl:inline">AI model</span>
        <b className="max-w-[11rem] truncate text-[14px]">{chat ? modelName(info, chat) : "Choose a model"}</b>
        <ChevronDownIcon size={14} />
      </button>
      {open && box
        ? createPortal(
            <div
              ref={pop}
              id={id}
              className="model-pop"
              style={{ top: box.top, right: box.right, width: box.width, maxHeight: box.max }}
              role="dialog"
              aria-label="Choose the AI model"
            >
              <div className="model-pop-head">
                <p className="text-[14px] font-semibold">AI model</p>
                <p className="text-[12.5px] faint">Does the thinking while you describe your assistant. Change it any time.</p>
              </div>

              <div className="model-list" role="menu" aria-label="AI models" onKeyDown={onListKey}>
                {info.models.map((m) => {
                  const on = m.name === chat;
                  const blocked = m.tools === false;
                  return (
                    <button
                      key={m.name}
                      type="button"
                      role="menuitemradio"
                      aria-checked={on}
                      disabled={blocked}
                      className="model-opt"
                      onClick={() => {
                        set({ chat: m.name });
                        setOpen(false);
                        btn.current?.focus();
                      }}
                      title={blocked ? "It cannot look things up in your workspace, which this needs" : m.label}
                    >
                      <span className="model-check" aria-hidden>
                        {on ? <CheckIcon size={13} /> : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-[14px] font-medium">{m.label}</span>
                          {m.recommended && !blocked ? <span className="model-tag model-tag-good">Recommended</span> : null}
                          {!m.recommended && !blocked ? <span className="model-tag">Not tested</span> : null}
                        </span>
                        <span className="block truncate text-[12.5px] faint">
                          {blocked ? "Can't be used here: it can't look things up" : [m.maker, m.tier].filter(Boolean).join(" · ") || m.detail}
                        </span>
                      </span>
                      <CostMark m={m} />
                    </button>
                  );
                })}
              </div>

              {picked && !picked.recommended ? (
                <p className="model-warn">
                  {picked.label} hasn&apos;t been tested here. In our tests, models other than Claude often skipped looking at what you already
                  have, so they may suggest building things that exist. A Recommended model is the safer choice.
                </p>
              ) : null}

              <div className="model-pop-foot">
                <button type="button" className="model-adv" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
                  <span className={advanced ? "inline-flex rotate-180 transition" : "inline-flex transition"} aria-hidden>
                    <ChevronDownIcon size={14} />
                  </span>
                  Advanced
                  {choice.code || choice.judge ? <span className="model-dot" title="Changed from the automatic choice" /> : null}
                </button>
                {advanced ? (
                  <div className="mt-3 space-y-4">
                    <div>
                      <p className="text-[13px] font-medium">Writes the code for new tools</p>
                      <div className="mt-1">
                        <Select
                          value={choice.code}
                          onChange={(v) => set({ code: v })}
                          ariaLabel="Model that writes the code of new tools"
                          options={[{ value: "", label: "Same as above", detail: chat ? modelName(info, chat) : undefined }, ...options]}
                        />
                      </div>
                      <p className="mt-1 text-[12px] faint">Only used when you ask for a new tool.</p>
                    </div>
                    <div>
                      <p className="text-[13px] font-medium">Marks the answers when your assistant is tested</p>
                      <div className="mt-1">
                        <Select
                          value={choice.judge}
                          onChange={(v) => set({ judge: v })}
                          ariaLabel="Model that marks the test answers"
                          options={[
                            {
                              value: "",
                              label: "Chosen for you",
                              detail: used?.judge ? `Currently ${modelName(info, used.judge)}` : "Always a different model from the one above",
                            },
                            ...options,
                          ]}
                        />
                      </div>
                      {sameChecker ? (
                        <p className="model-warn !mx-0 !mb-0 mt-2">The same model would build your assistant and mark it. Pick a different one.</p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className="text-[12px] faint">Runs as you, so it only sees what you can. Remembered in this browser.</p>
                  {anyChoice ? (
                    <button type="button" className="shrink-0 text-[12.5px] font-medium underline" onClick={() => onChange({ ...NO_CHOICE })}>
                      Use the defaults
                    </button>
                  ) : null}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
