"use client";

import type { DesignerInfo, DesignerModels } from "@/lib/api";
import { modelDetail, NO_CHOICE } from "@/lib/designerModels";
import { Select } from "../bits";
import { ChevronDownIcon, SparkleIcon } from "../icons";

/** The AI model, as one small button in the header that opens a plain panel.
 *
 *  Most people make one choice here, if any, so that is all that is shown. The two
 *  specialist jobs (writing a new tool's code, marking the test answers) sit under
 *  "Fine tune" with sensible automatic choices, and say what "automatic" means. */

export function modelName(info: DesignerInfo, name: string): string {
  return info.models.find((m) => m.name === name)?.label || name;
}

export function ModelChip({
  info,
  choice,
  open,
  onToggle,
}: {
  info: DesignerInfo;
  choice: DesignerModels;
  open: boolean;
  onToggle: () => void;
}) {
  const eff = choice.chat || info.defaults.chat;
  return (
    <button
      type="button"
      className="btn btn-quiet"
      aria-expanded={open}
      aria-controls="designer-model-panel"
      onClick={onToggle}
      title="Choose which AI model does the thinking"
    >
      <SparkleIcon size={15} />
      <span className="hidden text-[13px] muted sm:inline">AI model</span>
      <b className="max-w-[10rem] truncate text-[14px]">{eff ? modelName(info, eff) : "Choose a model"}</b>
      <ChevronDownIcon size={14} />
    </button>
  );
}

export function ModelPanel({
  info,
  choice,
  used,
  onChange,
  onClose,
}: {
  info: DesignerInfo;
  choice: DesignerModels;
  /** What the last turn really used (after defaults), when known. */
  used: DesignerModels | null;
  onChange: (c: DesignerModels) => void;
  onClose: () => void;
}) {
  const chat = choice.chat || info.defaults.chat;
  const picked = info.models.find((m) => m.name === chat);
  const options = info.models.map((m) => ({ value: m.name, label: m.label, detail: modelDetail(m) }));
  // The interview calls functions to look things up, so a model that cannot is shown but cannot be chosen for it.
  const chatOptions = info.models.map((m) => ({
    value: m.name,
    label: m.label,
    detail: modelDetail(m),
    disabled: m.tools === false,
    note: m.tools === false ? "No tool use" : undefined,
  }));
  const judgeNow = choice.judge || used?.judge || "";
  const sameChecker = judgeNow !== "" && judgeNow === chat;
  const set = (patch: Partial<DesignerModels>) => onChange({ ...choice, ...patch });

  return (
    <section
      id="designer-model-panel"
      className="card mb-5 max-w-2xl p-5"
      aria-label="Choose the AI model"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <h3 className="text-[15px] font-semibold">Which AI model should do the thinking?</h3>
      <p className="mt-1 text-sm muted">
        You can change this at any time, even in the middle of a conversation. It is remembered in this browser.
      </p>

      <div className="mt-3">
        <Select value={chat} onChange={(v) => set({ chat: v })} options={chatOptions} ariaLabel="AI model" placeholder="Choose a model…" />
        {picked?.cost ? (
          <p className="help">
            {picked.cost}: {picked.price_in ?? "?"} in, {picked.price_out ?? "?"} out, in DBUs per million tokens. Your spend by model is on the Insights page.
          </p>
        ) : null}
        {picked && !picked.recommended ? (
          <p className="notice mt-2">
            This model has not been tested with the designer, and in our tests most models other than Claude skipped the step of looking at
            what you already have. It may suggest building things that already exist, or ask questions that do not fit. A Claude model is the
            safer choice.
          </p>
        ) : picked ? (
          <p className="help">Recommended: it handles the looking-up and step-by-step work this needs.</p>
        ) : null}
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-medium">Fine tune (optional)</summary>
        <div className="mt-3 space-y-4">
          <label className="block">
            <span className="text-sm font-medium">Writes the code for new tools</span>
            <div className="mt-1">
              <Select
                value={choice.code}
                onChange={(v) => set({ code: v })}
                ariaLabel="Model that writes the code of new tools"
                options={[{ value: "", label: "Same as the AI model above", detail: modelName(info, chat) }, ...options]}
              />
            </div>
            <span className="help">Only used if you ask for a new tool. A stronger model can write better code, and usually costs more.</span>
          </label>
          <label className="block">
            <span className="text-sm font-medium">Checks the answers when your assistant is tested</span>
            <div className="mt-1">
              <Select
                value={choice.judge}
                onChange={(v) => set({ judge: v })}
                ariaLabel="Model that checks the test answers"
                options={[
                  {
                    value: "",
                    label: "Chosen for you",
                    detail: used?.judge ? `Currently ${modelName(info, used.judge)}` : "A different model from the one above",
                  },
                  ...options,
                ]}
              />
            </div>
            {sameChecker ? (
              <p className="notice mt-2">The model that builds your assistant is also marking it. That is less reliable: pick a different one.</p>
            ) : (
              <span className="help">A different model marks the answers, so the one that built it is not grading its own work.</span>
            )}
          </label>
        </div>
      </details>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-md text-[13px] faint">
          The model sees what you type and the names of things in your workspace. It runs as you, so it can only see what you can.
        </p>
        <div className="flex gap-2">
          <button type="button" className="btn btn-quiet" onClick={() => onChange({ ...NO_CHOICE })} disabled={!choice.chat && !choice.code && !choice.judge}>
            Reset to defaults
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </section>
  );
}
