"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Agent, SavedChat, Session } from "@/lib/api";
import { AgentCard, kindMeta } from "./AgentCard";
import { CardList, Empty, ErrorBox, Spinner } from "./bits";
import { ClockIcon, SearchIcon } from "./icons";

/** "Hi Soham" reads better than "Hi soham.kamtikar@databeat.io". */
export function firstName(display: string) {
  const base = (display || "").split("@")[0].replace(/[._]/g, " ").trim();
  const first = base.split(/\s+/)[0] || "there";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** "5 min ago", "Yesterday", "12 Sep": how people talk about time. */
export function whenAgo(iso: string) {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return "Yesterday";
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** The home page: who you are, what you can use, and where you left off. */
export function Home({
  session,
  agents,
  agentsErr,
  recents,
  onOpen,
  onResume,
}: {
  session: Session;
  agents: Agent[] | null;
  agentsErr: string;
  recents: SavedChat[] | null;
  onOpen: (a: Agent) => void;
  onResume: (a: Agent, id: string) => void;
}) {
  const [find, setFind] = useState("");
  const [kind, setKind] = useState("all");
  const [hello, setHello] = useState("Welcome back");
  const searchRef = useRef<HTMLInputElement>(null);

  // The time of day only exists in the browser; reading it during the static
  // export would bake in the build machine's clock.
  useEffect(() => setHello(greeting()), []);

  const list = agents || [];
  const kinds = useMemo(() => {
    const seen = new Map<string, number>();
    for (const a of list) seen.set(a.kind, (seen.get(a.kind) || 0) + 1);
    return Array.from(seen.entries());
  }, [list]);

  const q = find.trim().toLowerCase();
  // Ready assistants first (the ones you can use now), otherwise A to Z.
  const shown = list
    .filter(
      (a) =>
        (kind === "all" || a.kind === kind) &&
        (!q || a.display_name.toLowerCase().includes(q) || (a.blurb || "").toLowerCase().includes(q))
    )
    .sort((x, y) => Number(y.ready) - Number(x.ready) || x.display_name.localeCompare(y.display_name, undefined, { numeric: true, sensitivity: "base" }));

  const byName = new Map(list.map((a) => [a.name, a]));
  const recent = (recents || []).filter((c) => byName.get(c.endpoint)?.ready).slice(0, 3);

  const ready = list.filter((a) => a.ready).length;
  const withFiles = list.filter((a) => a.supports_files || a.output_volume).length;

  return (
    <div className="space-y-10">
      {/* Banner */}
      <section className="hero px-6 py-8 sm:px-10 sm:py-10">
        <div className="grid items-end gap-8 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div className="max-w-2xl">
            <p className="text-[13px] font-semibold uppercase tracking-[0.14em] text-white/70">{hello}</p>
            <h1 className="mt-2 text-[28px] font-semibold leading-[1.15] tracking-[-0.02em] sm:text-[34px]">
              Hi {firstName(session.display_name)}, how can we help today?
            </h1>
            <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-white/80">
              Pick an assistant and ask your question the way you would ask a colleague. Your
              assistants work on your organisation&rsquo;s own data, with your own access.
            </p>
            <label className="hero-search mt-6 max-w-xl">
              <span style={{ color: "#667085" }}>
                <SearchIcon size={20} />
              </span>
              <input
                ref={searchRef}
                type="search"
                value={find}
                onChange={(e) => setFind(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && shown.length === 1 && shown[0].ready) onOpen(shown[0]);
                }}
                placeholder="Find an assistant by name or what it does"
                aria-label="Find an assistant"
              />
            </label>
          </div>

          {agents && agents.length ? (
            <dl className="grid grid-cols-3 gap-3 lg:w-[380px]">
              <Stat label="Assistants" value={list.length} />
              <Stat label="Ready now" value={ready} />
              <Stat label="Use files" value={withFiles} />
            </dl>
          ) : null}
        </div>
      </section>

      <ErrorBox>{agentsErr}</ErrorBox>

      {/* Where you left off */}
      {recent.length ? (
        <section aria-labelledby="recent-h">
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <h2 id="recent-h" className="text-lg font-semibold tracking-[-0.01em]">
              Pick up where you left off
            </h2>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {recent.map((c) => {
              const a = byName.get(c.endpoint)!;
              const k = kindMeta(a.kind, a.kind_label);
              return (
                <button key={c.id} type="button" className="recent-tile" onClick={() => onResume(a, c.id)}>
                  <span aria-hidden className={`kind-tile !h-9 !w-9 !rounded-lg ${k.cls}`}>
                    {k.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{c.title || "Untitled conversation"}</span>
                    <span className="mt-0.5 block truncate text-[13px] faint">{a.display_name}</span>
                    <span className="mt-2 inline-flex items-center gap-1.5 text-xs faint">
                      <ClockIcon size={13} />
                      {whenAgo(c.updated)}
                      <span aria-hidden>·</span>
                      {c.count} {c.count === 1 ? "message" : "messages"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* All assistants */}
      <section aria-labelledby="agents-h">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="agents-h" className="text-lg font-semibold tracking-[-0.01em]">
              Your assistants
            </h2>
            <p className="mt-0.5 text-sm muted">Only the assistants you have been given access to are shown.</p>
          </div>
          {kinds.length > 1 ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by kind">
              <button type="button" className="filter-chip" aria-pressed={kind === "all"} onClick={() => setKind("all")}>
                All <span className="count">{list.length}</span>
              </button>
              {kinds.map(([k, n]) => (
                <button key={k} type="button" className="filter-chip" aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {kindMeta(k).label} <span className="count">{n}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {agents === null ? (
          <Spinner label="Loading your assistants…" />
        ) : agents.length === 0 ? (
          <Empty
            title="You do not have any assistants yet"
            hint="An admin needs to give you access before anything appears here."
          />
        ) : shown.length === 0 ? (
          <div className="card px-6 py-10 text-center">
            <p className="text-sm font-medium">No assistants match {find ? <>“{find}”</> : "this filter"}.</p>
            <button
              type="button"
              className="btn btn-quiet mt-4"
              onClick={() => {
                setFind("");
                setKind("all");
                searchRef.current?.focus();
              }}
            >
              Show all assistants
            </button>
          </div>
        ) : (
          // The banner search does the filtering, so the list only pages.
          // Keyed on the filter so a new search starts back at the first page.
          <CardList
            key={kind + "|" + q}
            items={shown}
            noun="assistants"
            searchFrom={Infinity}
            className="card-grid !gap-5"
            keyOf={(a) => a.name}
            text={(a) => a.display_name}
            render={(a) => <AgentCard agent={a} onOpen={onOpen} />}
          />
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="hero-stat">
      <dt className="text-[12px] font-medium leading-tight text-white/70">{label}</dt>
      <dd className="mt-1 text-[26px] font-semibold leading-none tabular-nums">{value}</dd>
    </div>
  );
}
