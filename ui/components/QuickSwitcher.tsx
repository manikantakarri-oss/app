"use client";

import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Agent } from "@/lib/api";
import { kindMeta } from "./AgentCard";
import { ChevronRightIcon, SearchIcon } from "./icons";

export type Page = { value: string; label: string; icon: ReactNode };

type Item =
  | { type: "agent"; key: string; label: string; hint: string; icon: ReactNode; agent: Agent }
  | { type: "page"; key: string; label: string; hint: string; icon: ReactNode; value: string };

/** Ctrl/Cmd + K: jump to any assistant or section by typing a few letters.
 *  Pure navigation - it only calls the same handlers the sidebar and cards do. */
export function QuickSwitcher({
  open,
  onClose,
  agents,
  pages,
  onAgent,
  onPage,
}: {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
  pages: Page[];
  onAgent: (a: Agent) => void;
  onPage: (value: string) => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const s = q.trim().toLowerCase();
    const a: Item[] = agents
      .filter((x) => x.ready)
      .filter((x) => !s || x.display_name.toLowerCase().includes(s) || (x.blurb || "").toLowerCase().includes(s))
      .map((x) => {
        const k = kindMeta(x.kind, x.kind_label);
        return { type: "agent", key: "a:" + x.name, label: x.display_name, hint: k.label, icon: k.icon, agent: x };
      });
    const p: Item[] = pages
      .filter((x) => !s || x.label.toLowerCase().includes(s))
      .map((x) => ({ type: "page", key: "p:" + x.value, label: x.label, hint: "Go to", icon: x.icon, value: x.value }));
    return [...a, ...p];
  }, [q, agents, pages]);

  useEffect(() => {
    if (sel >= items.length) setSel(Math.max(0, items.length - 1));
  }, [items.length, sel]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  function choose(it: Item | undefined) {
    if (!it) return;
    onClose();
    if (it.type === "agent") onAgent(it.agent);
    else onPage(it.value);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[sel]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  const agentCount = items.filter((i) => i.type === "agent").length;

  return (
    <div className="palette-backdrop flex items-start justify-center px-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        className="palette w-full max-w-xl"
        role="dialog"
        aria-modal="true"
        aria-label="Quick switcher"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="flex items-center gap-3 border-b px-4" style={{ borderColor: "var(--line)" }}>
          <span className="faint">
            <SearchIcon size={18} />
          </span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            placeholder="Search assistants and pages…"
            aria-label="Search assistants and pages"
            role="combobox"
            aria-expanded="true"
            aria-controls="qs-list"
            aria-activedescendant={items[sel] ? "qs-" + sel : undefined}
            className="h-14 w-full bg-transparent text-[15px] outline-none"
          />
          <span className="kbd faint">Esc</span>
        </div>
        <div ref={listRef} id="qs-list" role="listbox" className="max-h-[min(60vh,420px)] overflow-y-auto p-2">
          {items.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm muted">Nothing matches “{q}”.</p>
          ) : (
            items.map((it, i) => (
              <div key={it.key}>
                {i === 0 && agentCount > 0 ? <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.1em] faint">Assistants</p> : null}
                {i === agentCount ? <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.1em] faint">Pages</p> : null}
                <button
                  type="button"
                  id={"qs-" + i}
                  data-idx={i}
                  role="option"
                  aria-selected={i === sel}
                  className="palette-item"
                  onMouseEnter={() => setSel(i)}
                  onClick={() => choose(it)}
                >
                  <span className={`kind-tile !h-8 !w-8 !rounded-lg ${it.type === "agent" ? kindMeta(it.agent.kind).cls : "kind-supervisor"}`} aria-hidden>
                    {it.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{it.label}</span>
                    <span className="block truncate text-xs faint">{it.hint}</span>
                  </span>
                  <span className="faint" aria-hidden>
                    <ChevronRightIcon size={16} />
                  </span>
                </button>
              </div>
            ))
          )}
        </div>
        <div className="flex items-center gap-4 border-t px-4 py-2.5 text-xs faint" style={{ borderColor: "var(--line)" }}>
          <span className="inline-flex items-center gap-1.5"><span className="kbd">↑</span><span className="kbd">↓</span> to move</span>
          <span className="inline-flex items-center gap-1.5"><span className="kbd">Enter</span> to open</span>
        </div>
      </div>
    </div>
  );
}
