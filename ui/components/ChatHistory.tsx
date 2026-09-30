"use client";

import { useState } from "react";
import { SavedChat } from "@/lib/api";
import { NewChatIcon, PanelLeftIcon, SearchIcon, TrashIcon } from "./icons";

/** The chat list, docked flush to the left edge of the chat.
 *
 *  Always visible on wide screens, so the three questions - where are my chats,
 *  which one am I in, how do I start another - are answered without a click.
 *  It folds to a slim rail of two icons (open the list, new chat) when the
 *  conversation needs the room. Chats are grouped by day, because that is how
 *  people remember them.
 */
export function ChatHistory({
  items,
  error,
  activeId,
  busy,
  onOpen,
  onNew,
  onDelete,
  collapsed = false,
  onToggle,
  className = "",
}: {
  items: SavedChat[] | null;
  error: string;
  activeId: string;
  busy: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  collapsed?: boolean;
  onToggle?: () => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  // The row whose delete is awaiting confirmation. Deleting is permanent, so it
  // takes two clicks, but a modal for it would be heavier than the action.
  const [confirming, setConfirming] = useState("");

  const q = query.trim().toLowerCase();
  const shown = (items || []).filter((c) => !q || c.title.toLowerCase().includes(q));
  const groups = groupByAge(shown);

  return (
    <aside
      className={
        "flex w-full shrink-0 flex-col overflow-hidden transition-[width] md:border-r " +
        (collapsed ? "md:w-14 " : "md:w-64 ") +
        className
      }
      style={{ background: "var(--surface)", borderColor: "var(--line)" }}
      aria-label="Your conversations"
    >
      {/* Slim rail: wide screens only, while folded. */}
      {collapsed ? (
        <div className="hidden flex-1 flex-col items-center gap-1 py-2 md:flex">
          <button
            type="button"
            className="icon-btn"
            onClick={onToggle}
            title="Open your chats"
            aria-label="Open your chats"
            aria-expanded={false}
          >
            <PanelLeftIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onNew}
            disabled={busy}
            title="New chat"
            aria-label="New chat"
          >
            <NewChatIcon />
          </button>
        </div>
      ) : null}

      <div className={collapsed ? "contents md:hidden" : "contents"}>
        <div className="flex h-12 shrink-0 items-center justify-between pl-4 pr-2">
          <span className="text-sm font-semibold">Chats</span>
          {onToggle ? (
            <button
              type="button"
              className="icon-btn hidden md:inline-flex"
              onClick={onToggle}
              title="Close the chat list"
              aria-label="Close the chat list"
              aria-expanded
            >
              <PanelLeftIcon />
            </button>
          ) : null}
        </div>

        <div className="shrink-0 px-2">
          <button type="button" className="row-btn" onClick={onNew} disabled={busy}>
            <NewChatIcon />
            <span>New chat</span>
          </button>
          {(items?.length || 0) > 5 ? (
            <label className="row-btn cursor-text">
              <SearchIcon />
              <input
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--ink-faint)]"
                type="search"
                placeholder="Search chats"
                aria-label="Search your chats"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {items === null ? (
            <p className="px-3 py-3 text-sm muted">Loading your chats…</p>
          ) : error ? (
            <p className="px-3 py-3 text-sm" style={{ color: "var(--err)" }}>
              {error}
            </p>
          ) : items.length === 0 ? (
            <p className="px-3 py-3 text-sm muted">
              Your conversations with this agent are listed here, so you can pick one up again.
            </p>
          ) : shown.length === 0 ? (
            <p className="px-3 py-3 text-sm muted">No chats match “{query}”.</p>
          ) : (
            groups.map(([label, rows]) => (
              <section key={label}>
                <h3 className="px-3 pb-1 pt-4 text-xs font-medium faint">{label}</h3>
                <ul>
                  {rows.map((c) => {
                    const active = c.id === activeId;
                    return (
                      <li
                        key={c.id}
                        className="group relative rounded-lg"
                        style={active ? { background: "var(--bubble)" } : undefined}
                      >
                        {confirming === c.id ? (
                          <div className="flex items-center gap-1 px-3 py-1.5 text-sm">
                            <span className="min-w-0 flex-1 truncate">Delete chat?</span>
                            <button
                              type="button"
                              className="rounded-md px-2 py-1 text-xs font-semibold"
                              style={{ color: "var(--err)" }}
                              onClick={() => {
                                setConfirming("");
                                onDelete(c.id);
                              }}
                            >
                              Delete
                            </button>
                            <button
                              type="button"
                              className="rounded-md px-2 py-1 text-xs muted"
                              onClick={() => setConfirming("")}
                            >
                              Keep
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => onOpen(c.id)}
                              disabled={busy}
                              aria-current={active ? "true" : undefined}
                              title={c.title}
                              className="block w-full truncate rounded-lg px-3 py-2 pr-9 text-left text-sm transition hover:bg-[var(--bubble)] disabled:opacity-60"
                            >
                              {c.title}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirming(c.id)}
                              disabled={busy}
                              className="absolute right-1 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md faint opacity-0 transition hover:text-[var(--err)] focus:opacity-100 group-hover:opacity-100"
                              aria-label={`Delete chat: ${c.title}`}
                              title="Delete this chat"
                            >
                              <TrashIcon size={16} />
                            </button>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>

        <p
          className="shrink-0 px-4 py-2.5 text-[11px] faint"
          style={{ borderTop: "1px solid var(--line)" }}
        >
          Saved to your account. Others using the portal cannot see them.
        </p>
      </div>
    </aside>
  );
}

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function groupByAge(items: SavedChat[]): [string, SavedChat[]][] {
  const today = startOfDay(new Date());
  const buckets = new Map<string, SavedChat[]>();
  const order = ["Today", "Yesterday", "Previous 7 days", "Older"];
  for (const c of items) {
    const t = new Date(c.updated).getTime();
    const day = isNaN(t) ? 0 : startOfDay(new Date(t));
    const label =
      day >= today
        ? "Today"
        : day >= today - DAY
          ? "Yesterday"
          : day >= today - 7 * DAY
            ? "Previous 7 days"
            : "Older";
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label)!.push(c);
  }
  return order.filter((l) => buckets.has(l)).map((l) => [l, buckets.get(l)!]);
}
