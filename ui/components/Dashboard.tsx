"use client";

import { ReactNode, useEffect, useMemo, useState } from "react";
import {
  Activity as ActivityData,
  Agent,
  api,
  CostRow,
  downloadUrl,
  FileItem,
  Insights,
  OrgOverview,
  PersonRow,
  SavedChat,
} from "@/lib/api";
import { initials, middleShort, nameOf } from "@/lib/people";
import { kindMeta } from "./AgentCard";
import { ErrorBox } from "./bits";
import {
  ArrowDownRightIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  ChevronLeftIcon,
  ClockIcon,
  DownloadIcon,
  FileIcon,
  MessageIcon,
  SearchIcon,
  SparkleIcon,
  ThreadsIcon,
  UploadIcon,
} from "./icons";

/** "My dashboard".
 *
 *  Everyone gets a personal workspace summary that is useful, not just counted:
 *  a plain-English summary, activity over time, their go-to assistants with a
 *  one-click "Ask", conversations to pick up again, when in the week they tend
 *  to work, and every file they sent or got back (downloadable again).
 *
 *  Admins also get "Everyone": adoption (active and new people), use per day,
 *  an assistant leaderboard with the ones nobody used, the people table and an
 *  estimated cost per person. Admins only ever see counts - what people asked,
 *  their chat titles and their files stay private to them, and the screen says so.
 *
 *  Charts follow one rule set: one measure per chart, one colour (the validated
 *  --chart-1 token), thin rounded-top columns, solid recessive gridlines, a real
 *  y-axis, hover read-outs, and a table view for every chart. Two measures of
 *  different scale (people vs questions) are two charts, never a dual axis.
 *  Changes against the previous period are an arrow AND a signed number; a fall
 *  is neutral grey, not red. Changing the period dims the old numbers until the
 *  new ones arrive instead of flashing a skeleton.
 */
export function Dashboard({
  isAdmin,
  onGoto,
  agents = [],
  onOpen,
  onResume,
}: {
  isAdmin: boolean;
  onGoto?: (tab: string) => void;
  agents?: Agent[];
  onOpen?: (a: Agent) => void;
  onResume?: (a: Agent, id: string) => void;
}) {
  const [view, setView] = useState<"me" | "everyone">("me");
  const [days, setDays] = useState(30);

  return (
    <div>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--brand-deep)" }}>
            {view === "me" ? "Your workspace" : "Across the portal"}
          </p>
          <h1 className="mt-1 text-[28px] font-semibold leading-tight tracking-[-0.02em]">
            {view === "me" ? "My dashboard" : "Everyone’s activity"}
          </h1>
          <p className="mt-1.5 max-w-2xl text-[15px] muted">
            {view === "me"
              ? "Your activity, the assistants you rely on, and everything you can pick up again."
              : "How the portal is being adopted and used. You see numbers only. What people asked, and their files, stay private to them."}
          </p>
        </div>

        {/* One control row scopes everything below it. */}
        <div className="flex flex-wrap items-center gap-2.5">
          {isAdmin ? (
            <div className="seg" role="tablist" aria-label="Whose dashboard">
              {(
                [
                  ["me", "Me"],
                  ["everyone", "Everyone"],
                ] as const
              ).map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)}>
                  {label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="seg" role="group" aria-label="Time period">
            {[7, 30, 90].map((d) => (
              <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>
                {d} days
              </button>
            ))}
          </div>
        </div>
      </div>

      {view === "me" ? (
        <Mine days={days} setDays={setDays} agents={agents} onGoto={onGoto} onOpen={onOpen} onResume={onResume} />
      ) : (
        <Everyone days={days} agents={agents} />
      )}
    </div>
  );
}

// ------------------------------------------------------------- plumbing -----

/** Fetch for a period, but keep the last answer on screen while the next one
 *  loads, so switching 7 -> 30 days dims the page instead of blanking it. */
function usePeriod<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setErr("");
    load()
      .then((d) => live && setData(d))
      .catch((e) => live && setErr(e.message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, err, busy };
}

function Dim({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <div aria-busy={busy} style={{ opacity: busy ? 0.55 : 1, transition: "opacity .15s" }}>
      {children}
    </div>
  );
}

/** 9,412 stays exact; 12,400 becomes "12.4K" so a tile never overflows. */
function fmt(n: number) {
  if (Math.abs(n) < 10000) return n.toLocaleString();
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function plural(n: number, one: string, many = one + "s") {
  return `${fmt(n)} ${n === 1 ? one : many}`;
}

function Panel({
  title,
  sub,
  right,
  children,
  className = "",
}: {
  title: string;
  sub?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card flex min-w-0 flex-col overflow-hidden ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4 sm:px-6" style={{ borderColor: "var(--line)" }}>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
          {sub ? <p className="mt-0.5 text-[13px] faint">{sub}</p> : null}
        </div>
        {right}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <div className="card h-[168px] animate-pulse" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="card h-[360px] animate-pulse" />
        <div className="card h-[360px] animate-pulse" />
      </div>
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="px-5 py-8 text-center text-sm muted sm:px-6">{children}</p>;
}

/** A whole-dashboard notice (history off, nothing yet) in the same card style. */
function Callout({ icon, title, children, actions }: { icon: ReactNode; title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="card relative overflow-hidden px-6 py-12 text-center sm:py-14">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(460px 200px at 50% 0%, var(--brand-soft), transparent 70%)" }}
      />
      <div className="relative">
        <span className="kind-tile kind-supervisor mx-auto !h-14 !w-14 !rounded-2xl" aria-hidden>
          {icon}
        </span>
        <p className="mt-5 text-lg font-semibold tracking-[-0.01em]">{title}</p>
        <div className="mx-auto mt-1.5 max-w-lg text-[15px] muted">{children}</div>
        {actions ? <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">{actions}</div> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- mine ------

function Mine({
  days,
  setDays,
  agents,
  onGoto,
  onOpen,
  onResume,
}: {
  days: number;
  setDays: (d: number) => void;
  agents: Agent[];
  onGoto?: (tab: string) => void;
  onOpen?: (a: Agent) => void;
  onResume?: (a: Agent, id: string) => void;
}) {
  const main = usePeriod(() => api.dashMe(days), [days]);
  // The extras load on their own, so a slow or failing one never holds up the rest.
  const extra = usePeriod(() => api.dashInsights(days), [days]);
  const recent = usePeriod<SavedChat[]>(() => api.chats("").then((r) => r.chats || []), []);

  const byName = useMemo(() => new Map(agents.map((a) => [a.name, a])), [agents]);
  const data = main.data;

  if (main.err && !data) return <ErrorBox>{main.err}</ErrorBox>;
  if (!data) return <Skeleton />;

  if (!data.enabled) {
    return (
      <Callout icon={<ClockIcon size={26} />} title="Your dashboard needs saved chat history">
        {data.note || "Saved chat history is turned off, so there is nothing to summarise yet."} Once an admin switches
        it on, your activity, conversations and files will show up here.
      </Callout>
    );
  }

  const chats = (recent.data || []).filter((c) => byName.has(c.endpoint));
  const suggestions = agents.filter((a) => a.ready).slice(0, 3);

  // Nothing in this period. Say so, and offer the two useful next steps.
  if (data.questions === 0) {
    const everUsed = (recent.data || []).length > 0;
    return (
      <Dim busy={main.busy}>
        <div className="space-y-6">
          <Callout
            icon={<SparkleIcon size={26} />}
            title={everUsed ? `No questions in the last ${days} days` : "Welcome to your dashboard"}
            actions={
              <>
                {everUsed && days < 90 ? (
                  <button type="button" className="btn btn-quiet" onClick={() => setDays(90)}>
                    Show the last 90 days
                  </button>
                ) : null}
                {onGoto ? (
                  <button type="button" className="btn btn-primary" onClick={() => onGoto("agents")}>
                    Browse assistants
                    <ArrowRightIcon size={16} />
                  </button>
                ) : null}
              </>
            }
          >
            {everUsed
              ? "Pick up a recent conversation below, or ask one of your assistants something new."
              : "Ask any assistant a question and this page fills up: your activity, the assistants you rely on, conversations to pick up again and every file you get back."}
          </Callout>

          {chats.length ? (
            <RecentChats chats={chats.slice(0, 6)} byName={byName} onResume={onResume} />
          ) : suggestions.length && onOpen ? (
            <Panel title="Good places to start" sub="Assistants you can use right now">
              <div className="grid gap-3 p-4 sm:grid-cols-3 sm:p-5">
                {suggestions.map((a) => {
                  const k = kindMeta(a.kind, a.kind_label);
                  return (
                    <button key={a.name} type="button" className="recent-tile" onClick={() => onOpen(a)} title={a.display_name}>
                      <span aria-hidden className={`kind-tile !h-9 !w-9 !rounded-lg ${k.cls}`}>
                        {k.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-medium">{middleShort(a.display_name, 40)}</span>
                        <span className="mt-0.5 line-clamp-2 block text-[13px] faint">{a.blurb || k.label}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </Panel>
          ) : null}
        </div>
      </Dim>
    );
  }

  const ins = extra.data;
  return (
    <Dim busy={main.busy}>
      <div className="space-y-6">
        <ErrorBox>{main.err}</ErrorBox>
        <Summary data={data} />

        <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Panel title="Your activity" sub={`Questions you asked each day, last ${data.days} days`}>
            <SeriesChart rows={data.per_day.map((d) => ({ day: d.day, value: d.questions }))} one="question" />
          </Panel>
          <GoTo rows={data.top_assistants} byName={byName} onOpen={onOpen} />
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          {chats.length ? (
            <RecentChats chats={chats.slice(0, 5)} byName={byName} onResume={onResume} compact />
          ) : (
            <Panel title="Pick up where you left off">
              <Quiet>{recent.data === null ? "Loading…" : "Your saved conversations will be listed here."}</Quiet>
            </Panel>
          )}
          <Panel title="When you use assistants" sub="Questions by day of the week and hour, in your time zone">
            {ins ? <WeekHeat hours={ins.hours} /> : extra.err ? <Quiet>Could not load this part.</Quiet> : <Quiet>Loading…</Quiet>}
          </Panel>
        </div>

        <FilesPanel files={ins?.files || null} err={extra.err} byName={byName} days={data.days} onResume={onResume} />

        <p className="flex items-start gap-2 text-xs faint">
          <span className="mt-px shrink-0">
            <ClockIcon size={14} />
          </span>
          <span>
            Counted from saved chats, so it only includes conversations since saved history was turned on.
            {data.last_active ? ` Last active ${when(data.last_active)}.` : ""}
          </span>
        </p>
      </div>
    </Dim>
  );
}

/** Days with at least one question, and how many of the most recent days in a
 *  row had one. A streak still counts if today is not over yet. */
function rhythm(perDay: { day: string; questions: number }[]) {
  const active = perDay.filter((d) => d.questions > 0).length;
  let i = perDay.length - 1;
  if (i >= 0 && perDay[i].questions === 0) i -= 1; // today may just not have started
  let streak = 0;
  for (; i >= 0 && perDay[i].questions > 0; i--) streak++;
  return { active, streak };
}

function Summary({ data, who }: { data: ActivityData; who?: string }) {
  const { active, streak } = rhythm(data.per_day);
  const top = data.top_assistants[0];
  return (
    <section className="card overflow-hidden">
      <div className="grid xl:grid-cols-[minmax(0,1.15fr)_minmax(0,2fr)]">
        <div className="relative px-6 py-6 sm:px-7">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: "linear-gradient(135deg, var(--brand-soft), transparent 70%)" }}
          />
          <div className="relative">
            <p className="text-[12px] font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--brand-deep)" }}>
              Last {data.days} days
            </p>
            <p className="mt-2 text-[19px] leading-snug tracking-[-0.01em]">
              {who ? <strong className="font-semibold">{who}</strong> : "You"} asked{" "}
              <strong className="font-semibold">{plural(data.questions, "question")}</strong> in{" "}
              <strong className="font-semibold">{plural(data.conversations, "conversation")}</strong>
              {top ? (
                <>
                  , mostly with <strong className="font-semibold">{middleShort(top.label, 40)}</strong>
                </>
              ) : null}
              .
            </p>
            <p className="mt-2 text-sm muted">
              {data.files_sent || data.files_back
                ? `${plural(data.files_sent, "file")} sent and ${plural(data.files_back, "file")} received.`
                : "No files sent or received."}
              {data.last_active ? ` Last active ${when(data.last_active)}.` : ""}
            </p>
          </div>
        </div>
        <div className="kpi-strip kpi-2x2 border-t xl:border-t-0" style={{ borderColor: "var(--line)" }}>
          <Kpi
            icon={<MessageIcon size={16} />}
            label="Questions"
            value={fmt(data.questions)}
            delta={{ cur: data.questions, prev: data.previous?.questions, days: data.days }}
            spark={data.per_day.map((d) => d.questions)}
          />
          <Kpi
            icon={<ThreadsIcon size={16} />}
            label="Conversations"
            value={fmt(data.conversations)}
            delta={{ cur: data.conversations, prev: data.previous?.conversations, days: data.days }}
          />
          <Kpi icon={<ClockIcon size={16} />} label="Active days" value={`${active}`} suffix={`of ${data.days}`} />
          <Kpi
            icon={<SparkleIcon size={16} />}
            label="Current streak"
            value={`${streak}`}
            suffix={streak === 1 ? "day" : "days"}
            hint={streak ? "Days in a row with a question" : "Ask something to start one"}
          />
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------- kpi ----

function Kpi({
  icon,
  label,
  value,
  suffix,
  hint,
  delta,
  spark,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  suffix?: string;
  hint?: string;
  delta?: { cur: number; prev?: number; days: number };
  spark?: number[];
}) {
  return (
    <div className="kpi">
      <div className="flex items-center gap-2 text-[13px] font-medium muted">
        <span className="kpi-icon" aria-hidden>
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        {/* Proportional figures at display size; tabular digits look loose here. */}
        <p className="min-w-0 truncate text-[30px] font-semibold leading-none tracking-[-0.025em]">
          {value}
          {suffix ? <span className="ml-1.5 text-sm font-medium tracking-normal faint">{suffix}</span> : null}
        </p>
        {/* A trend needs a few points; one busy day draws a broken-looking line. */}
        {spark && spark.filter((n) => n > 0).length >= 3 ? <Spark values={spark} /> : null}
      </div>
      <div className="mt-3 min-h-[22px]">
        {delta ? <Delta {...delta} /> : hint ? <span className="text-xs faint">{hint}</span> : null}
      </div>
    </div>
  );
}

/** A 2px trend line with the last point marked. Decoration for the number
 *  beside it, which carries the value; the chart has the detail. */
function Spark({ values }: { values: number[] }) {
  const W = 72;
  const H = 28;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? W / (values.length - 1) : W;
  const pts = values.map((v, i) => [i * step, H - 3 - (v / max) * (H - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden className="hidden shrink-0 overflow-visible sm:block">
      <path d={`${line} L${W},${H} L0,${H} Z`} fill="var(--chart-1)" opacity={0.12} />
      <path d={line} fill="none" stroke="var(--chart-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r={3} fill="var(--chart-1)" stroke="var(--surface)" strokeWidth={2} />
    </svg>
  );
}

/** Change against the period just before. An arrow and a signed number, so the
 *  direction never depends on colour. A fall is neutral grey rather than red:
 *  using the assistants less is not an error. */
function Delta({ cur, prev, days }: { cur: number; prev?: number; days: number }) {
  if (prev == null) return null;
  if (cur === 0 && prev === 0) return <span className="text-xs faint">No activity either period</span>;
  const title = `Compared with the previous ${days} days (${prev.toLocaleString()})`;

  let badge: ReactNode;
  let color = "var(--ink-dim)";
  if (prev === 0) {
    color = "var(--ok)";
    badge = (
      <>
        <ArrowUpRightIcon size={13} /> New
      </>
    );
  } else {
    const pct = Math.round(((cur - prev) / prev) * 100);
    if (pct === 0) badge = "No change";
    else if (pct > 0) {
      color = "var(--ok)";
      badge = (
        <>
          <ArrowUpRightIcon size={13} />+{pct > 999 ? "999+" : pct}%
        </>
      );
    } else {
      badge = (
        <>
          <ArrowDownRightIcon size={13} />−{Math.abs(pct)}%
        </>
      );
    }
  }

  return (
    <span className="flex min-w-0 max-w-full items-center gap-2 text-xs faint" title={title}>
      <span className="delta" style={{ color }}>
        {badge}
      </span>
      <span className="min-w-0 truncate">vs previous {days} days</span>
    </span>
  );
}

// ------------------------------------------------------------- charts -------

/** A round maximum for the y-axis: 4, 5, 8, 10, 20, 50 ... */
function niceMax(n: number) {
  if (n <= 4) return 4;
  const p = Math.pow(10, Math.floor(Math.log10(n)));
  for (const m of [1, 2, 5, 10]) if (n <= m * p) return m * p;
  return 10 * p;
}

/** One measure per day as thin columns, with a summary row, an "Avg" reference
 *  once there is enough data for it to mean something, and a table twin. */
function SeriesChart({ rows, one, many, height = 190 }: { rows: { day: string; value: number }[]; one: string; many?: string; height?: number }) {
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const n = rows.length;
  if (!n) return <Quiet>No data for this period.</Quiet>;

  const H = height;
  const top = niceMax(Math.max(...rows.map((d) => d.value), 1));
  const total = rows.reduce((s, d) => s + d.value, 0);
  const busiest = rows.reduce((b, d) => (d.value > b.value ? d : b), rows[0]);
  const avg = total / n;
  const avgText = avg >= 10 ? Math.round(avg).toString() : avg.toFixed(1);
  // An average over one or two active days says nothing and hugs the baseline.
  const showAvg = rows.filter((d) => d.value > 0).length >= 3;
  const avgY = (1 - avg / top) * (H - 1);
  const gap = n > 45 ? 1 : n > 20 ? 2 : 4;
  const labelIdx = n <= 7 ? rows.map((_, i) => i) : [0, 1, 2, 3, 4].map((k) => Math.round((k * (n - 1)) / 4));
  const word = (v: number) => (v === 1 ? one : many || one + "s");

  return (
    <div className="flex flex-1 flex-col px-5 pb-5 pt-4 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <dl className="grid min-w-0 flex-1 grid-cols-3 gap-4">
          <Stat label="Total" value={fmt(total)} />
          <Stat label="Daily average" value={avgText} />
          <Stat label="Busiest day" value={busiest.value ? `${shortDay(busiest.day)} · ${fmt(busiest.value)}` : "—"} />
        </dl>
        <div className="seg !p-0.5" role="group" aria-label="Show as">
          <button type="button" aria-pressed={!asTable} onClick={() => setAsTable(false)} className="!min-h-[28px] !px-2.5 !text-[12px]">
            Chart
          </button>
          <button type="button" aria-pressed={asTable} onClick={() => setAsTable(true)} className="!min-h-[28px] !px-2.5 !text-[12px]">
            Table
          </button>
        </div>
      </div>

      {asTable ? (
        <div className="mt-4 max-h-[240px] overflow-auto rounded-lg border" style={{ borderColor: "var(--line)" }}>
          <table className="w-full text-sm">
            <thead className="sticky top-0" style={{ background: "var(--surface)" }}>
              <tr className="text-left text-xs faint">
                <th className="px-4 py-2.5 font-medium">Day</th>
                <th className="px-4 py-2.5 text-right font-medium capitalize">{many || one + "s"}</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((d) => (
                <tr key={d.day} style={{ borderTop: "1px solid var(--line)" }}>
                  <td className="px-4 py-2">{longDay(d.day)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{d.value.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-5">
          <div className={`flex gap-3 ${showAvg ? "pr-9" : ""}`}>
            <div className="relative w-8 shrink-0 text-right text-[11px] faint tabular-nums" style={{ height: H }} aria-hidden>
              {[1, 0.5, 0].map((f) => (
                <span key={f} className="absolute right-0 -translate-y-1/2" style={{ top: (1 - f) * (H - 1) }}>
                  {fmt(Math.round(top * f))}
                </span>
              ))}
            </div>
            <div className="relative min-w-0 flex-1" style={{ height: H }} onMouseLeave={() => setHover(null)}>
              {[0, 0.5, 1].map((f) => (
                <div key={f} aria-hidden className="absolute left-0 right-0" style={{ top: (1 - f) * (H - 1), borderTop: "1px solid var(--line)" }} />
              ))}
              <div className="absolute inset-0 flex items-end" style={{ gap }}>
                {rows.map((d, i) => (
                  <div
                    key={d.day}
                    className="flex h-full min-w-0 flex-1 items-end justify-center"
                    onMouseEnter={() => setHover(i)}
                    title={`${longDay(d.day)}: ${d.value} ${word(d.value)}`}
                  >
                    <div
                      style={{
                        width: "100%",
                        maxWidth: 22,
                        height: d.value ? Math.max(3, (d.value / top) * (H - 1)) : 0,
                        background: "var(--chart-1)",
                        borderRadius: "4px 4px 0 0",
                        opacity: hover === null || hover === i ? 1 : 0.45,
                        transition: "opacity .12s",
                      }}
                    />
                  </div>
                ))}
              </div>
              {showAvg ? (
                <div aria-hidden className="pointer-events-none absolute left-0 right-0" style={{ top: avgY }}>
                  <div style={{ borderTop: "1.5px solid var(--ink-faint)", opacity: 0.7 }} />
                  <span className="absolute left-full ml-2 -translate-y-1/2 whitespace-nowrap text-[11px] font-semibold" style={{ color: "var(--ink-dim)" }}>
                    Avg
                    <span className="block font-normal faint">{avgText}</span>
                  </span>
                </div>
              ) : null}
              {hover !== null ? (
                <div
                  role="status"
                  className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-lg px-3 py-2 text-xs"
                  style={{
                    left: `${Math.min(86, Math.max(14, ((hover + 0.5) / n) * 100))}%`,
                    top: Math.max(0, (1 - rows[hover].value / top) * (H - 1) - 58),
                    background: "var(--ink)",
                    color: "var(--canvas)",
                    boxShadow: "var(--shadow-lg)",
                  }}
                >
                  <span className="block opacity-70">{longDay(rows[hover].day)}</span>
                  <span className="block text-sm font-semibold tabular-nums">
                    {rows[hover].value.toLocaleString()} {word(rows[hover].value)}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
          <div className={`mt-2 flex justify-between pl-11 text-xs faint ${showAvg ? "pr-9" : ""}`}>
            {labelIdx.map((i) => (
              <span key={i}>{n <= 7 ? weekday(rows[i].day) : shortDay(rows[i].day)}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs faint">{label}</dt>
      <dd className="mt-1 truncate text-[16px] font-semibold tracking-[-0.01em]">{value}</dd>
    </div>
  );
}

// --------------------------------------------------------- week heatmap -----

const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEK_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Questions by weekday and hour, placed in the viewer's own time zone. One hue
 *  stepped light to dark (sequential), empty cells in the neutral surface, with
 *  a scale legend, per-cell read-outs and a sentence that says the pattern. */
function WeekHeat({ hours }: { hours: Insights["hours"] }) {
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  const grid = useMemo(() => {
    const g = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    for (const b of hours) {
      const t = new Date(b.hour);
      if (isNaN(t.getTime())) continue;
      const d = (t.getDay() + 6) % 7; // Monday first
      g[d][t.getHours()] += b.questions;
    }
    return g;
  }, [hours]);
  const total = grid.flat().reduce((a, b) => a + b, 0);
  if (total < 5) {
    return <Quiet>Ask a few more questions and a pattern of when you work will appear here.</Quiet>;
  }
  const max = Math.max(...grid.flat(), 1);
  const level = (v: number) => (v === 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4)));
  const byDay = grid.map((r) => r.reduce((a, b) => a + b, 0));
  const topDay = byDay.indexOf(Math.max(...byDay));
  const byHour = Array.from({ length: 24 }, (_, h) => grid.reduce((a, r) => a + r[h], 0));
  const topHour = byHour.indexOf(Math.max(...byHour));
  const hourLabel = (h: number) => new Date(2020, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" });

  return (
    <div className="flex flex-1 flex-col px-5 pb-5 pt-4 sm:px-6">
      <p className="text-sm">
        You are busiest on <strong className="font-semibold">{WEEK_LONG[topDay]}s</strong>, around{" "}
        <strong className="font-semibold">{hourLabel(topHour)}</strong>.
      </p>
      <div className="mt-4 overflow-x-auto">
        <div className="min-w-[440px]" onMouseLeave={() => setHover(null)}>
          {grid.map((row, d) => (
            <div key={d} className="flex items-center gap-2">
              <span className="w-8 shrink-0 text-[11px] faint">{WEEK[d]}</span>
              <div className="grid flex-1 gap-[3px] py-[1.5px]" style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}>
                {row.map((v, h) => (
                  <span
                    key={h}
                    className={`heat heat-${level(v)}`}
                    title={`${WEEK[d]} ${hourLabel(h)}: ${v} ${v === 1 ? "question" : "questions"}`}
                    onMouseEnter={() => setHover({ d, h })}
                    style={hover && hover.d === d && hover.h === h ? { outline: "2px solid var(--ink)", outlineOffset: 1 } : undefined}
                  />
                ))}
              </div>
            </div>
          ))}
          <div className="ml-10 mt-1.5 flex justify-between text-[11px] faint">
            {[0, 6, 12, 18].map((h) => (
              <span key={h}>{hourLabel(h)}</span>
            ))}
            <span aria-hidden> </span>
          </div>
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-4 text-[11px] faint">
        <span aria-live="polite">
          {hover
            ? `${WEEK[hover.d]} ${hourLabel(hover.h)}: ${plural(grid[hover.d][hover.h], "question")}`
            : `${plural(total, "question")} in this period`}
        </span>
        <span className="inline-flex items-center gap-1.5" aria-label="Fewer to more questions">
          Fewer
          {[0, 1, 2, 3, 4].map((l) => (
            <span key={l} className={`heat heat-${l} !h-3 !w-3`} aria-hidden />
          ))}
          More
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------- go-to assistants ---------

function GoTo({
  rows,
  byName,
  onOpen,
}: {
  rows: ActivityData["top_assistants"];
  byName: Map<string, Agent>;
  onOpen?: (a: Agent) => void;
}) {
  const [all, setAll] = useState(false);
  const sum = rows.reduce((n, r) => n + r.questions, 0) || 1;
  const max = Math.max(...rows.map((r) => r.questions), 1);
  const shown = all ? rows : rows.slice(0, 5);
  return (
    <Panel title="Your go-to assistants" sub="Where your questions went">
      {rows.length === 0 ? (
        <Quiet>No assistants used in this period.</Quiet>
      ) : (
        <ol className="flex flex-1 flex-col px-2 py-2">
          {shown.map((r, i) => {
            const a = byName.get(r.name);
            const k = kindMeta(a?.kind || "agent", a?.kind_label);
            return (
              <li key={r.name} className="flex items-center gap-3 rounded-lg px-3 py-3 sm:px-4">
                <span className={`kind-tile !h-9 !w-9 !rounded-lg ${k.cls}`} aria-hidden>
                  {k.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-[14.5px] font-medium" title={r.label}>
                      <span className="sr-only">{i + 1}. </span>
                      {middleShort(r.label, 34)}
                    </span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">
                      {fmt(r.questions)}
                      <span className="ml-1.5 text-xs font-normal faint">{Math.round((r.questions / sum) * 100)}%</span>
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--bubble)" }}>
                    <div className="h-full rounded-full" style={{ width: `${Math.max(2, (r.questions / max) * 100)}%`, background: "var(--chart-1)" }} />
                  </div>
                </div>
                {onOpen ? (
                  a?.ready ? (
                    <button type="button" className="btn btn-quiet !min-h-[32px] !px-3 !text-[13px]" onClick={() => onOpen(a)} title={`Ask ${a.display_name}`}>
                      Ask
                    </button>
                  ) : (
                    <span className="w-[52px] shrink-0 text-center text-[11px] leading-tight faint" title={a ? "Starting up" : "You no longer have access to this assistant"}>
                      {a ? "Starting" : "No access"}
                    </span>
                  )
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {rows.length > 5 ? (
        <div className="border-t px-6 py-2.5" style={{ borderColor: "var(--line)" }}>
          <button type="button" className="text-[13px] font-medium" style={{ color: "var(--brand-deep)" }} onClick={() => setAll(!all)}>
            {all ? "Show top 5" : `Show all ${rows.length}`}
          </button>
        </div>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------- recent chats ----------

function RecentChats({
  chats,
  byName,
  onResume,
  compact,
}: {
  chats: SavedChat[];
  byName: Map<string, Agent>;
  onResume?: (a: Agent, id: string) => void;
  compact?: boolean;
}) {
  return (
    <Panel title="Pick up where you left off" sub="Your most recent conversations">
      <ul className={compact ? "flex flex-col px-2 py-2" : "grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3"}>
        {chats.map((c) => {
          const a = byName.get(c.endpoint)!;
          const k = kindMeta(a.kind, a.kind_label);
          const can = a.ready && !!onResume;
          return (
            <li key={c.id}>
              <button
                type="button"
                disabled={!can}
                onClick={() => can && onResume!(a, c.id)}
                className="row-btn !items-start !gap-3 !px-3 !py-2.5 disabled:cursor-not-allowed"
                title={c.title}
              >
                <span aria-hidden className={`kind-tile !h-8 !w-8 !rounded-lg ${k.cls}`}>
                  {k.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium">{c.title || "Untitled conversation"}</span>
                  <span className="mt-0.5 block truncate text-[12px] faint">
                    {middleShort(a.display_name, 30)} · {whenAgo(c.updated)} · {plural(c.count, "message")}
                  </span>
                </span>
                {can ? (
                  <span className="mt-1.5 shrink-0 faint" aria-hidden>
                    <ArrowRightIcon size={15} />
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

// ------------------------------------------------------------- files --------

function FilesPanel({
  files,
  err,
  byName,
  days,
  onResume,
}: {
  files: FileItem[] | null;
  err: string;
  byName: Map<string, Agent>;
  days: number;
  onResume?: (a: Agent, id: string) => void;
}) {
  const [dir, setDir] = useState<"all" | "received" | "sent">("all");
  const [more, setMore] = useState(false);
  if (files === null) {
    return (
      <Panel title="Your files">
        <Quiet>{err ? "Could not load your files." : "Loading…"}</Quiet>
      </Panel>
    );
  }
  const received = files.filter((f) => f.direction === "received").length;
  const list = files.filter((f) => dir === "all" || f.direction === dir);
  const shown = more ? list : list.slice(0, 8);

  return (
    <Panel
      title="Your files"
      sub={files.length ? `Files you sent and got back, last ${days} days` : undefined}
      right={
        files.length ? (
          <div className="seg !p-0.5" role="group" aria-label="Which files">
            {(
              [
                ["all", `All ${files.length}`],
                ["received", `Received ${received}`],
                ["sent", `Sent ${files.length - received}`],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" aria-pressed={dir === k} onClick={() => setDir(k)} className="!min-h-[28px] !px-2.5 !text-[12px]">
                {label}
              </button>
            ))}
          </div>
        ) : null
      }
    >
      {files.length === 0 ? (
        <Quiet>No files sent or received in the last {days} days. Reports and files assistants give you will be kept here.</Quiet>
      ) : list.length === 0 ? (
        <Quiet>None in this view.</Quiet>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {shown.map((f, i) => {
                const a = byName.get(f.endpoint);
                const canDownload = f.direction === "received" && !!a?.output_volume && !!f.path;
                const ext = (f.name.split(".").pop() || "").slice(0, 4).toUpperCase();
                return (
                  <tr key={`${f.conversation_id}-${f.path || f.name}-${i}`} style={{ borderTop: i ? "1px solid var(--line)" : undefined }}>
                    <td className="py-3 pl-5 pr-3 sm:pl-6">
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="file-badge" aria-hidden>
                          <FileIcon size={16} />
                          {ext ? <span>{ext}</span> : null}
                        </span>
                        <span className="min-w-0">
                          <span className="block max-w-[150px] truncate font-medium sm:max-w-[340px]" title={f.name}>
                            {middleShort(f.name, 44)}
                          </span>
                          <span className="block max-w-[150px] truncate text-xs faint sm:max-w-none">
                            {/* Phones have no room for the badge column, so say it here. */}
                            <span className="sm:hidden">{f.direction === "received" ? "Received" : "Sent"} · </span>
                            {middleShort(f.label, 36)}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-3 sm:table-cell">
                      <span className={`status-pill ${f.direction === "received" ? "status-ready" : "status-wait"}`}>
                        {f.direction === "received" ? <DownloadIcon size={12} /> : <UploadIcon size={12} />}
                        {f.direction === "received" ? "Received" : "Sent"}
                      </span>
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-3 muted md:table-cell">{f.at ? whenAgo(f.at) : ""}</td>
                    <td className="whitespace-nowrap py-3 pl-3 pr-5 text-right sm:pr-6">
                      <span className="inline-flex items-center gap-2">
                        {a?.ready && onResume ? (
                          <button
                            type="button"
                            className="btn btn-quiet !min-h-[32px] !px-2.5 !text-[13px]"
                            onClick={() => onResume(a, f.conversation_id)}
                            title="Open the conversation this file came from"
                          >
                            Chat
                          </button>
                        ) : null}
                        {canDownload ? (
                          <a className="btn btn-primary !min-h-[32px] !px-2.5 !text-[13px]" href={downloadUrl(f.endpoint, f.path)} download>
                            <DownloadIcon size={14} />
                            Download
                          </a>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {list.length > 8 ? (
        <div className="border-t px-6 py-2.5" style={{ borderColor: "var(--line)" }}>
          <button type="button" className="text-[13px] font-medium" style={{ color: "var(--brand-deep)" }} onClick={() => setMore(!more)}>
            {more ? "Show fewer" : `Show all ${list.length}`}
          </button>
        </div>
      ) : null}
    </Panel>
  );
}

// ------------------------------------------------------------- everyone -----

type SortKey = "questions" | "conversations" | "assistants" | "last_active";
const PEOPLE_PAGE = 25;

function Everyone({ days, agents }: { days: number; agents: Agent[] }) {
  const org = usePeriod<OrgOverview>(() => api.dashOrg(days), [days]);
  const ppl = usePeriod(() => api.dashPeople(days), [days]);
  const [who, setWho] = useState<string | null>(null);

  if (who) return <Person user={who} days={days} onBack={() => setWho(null)} />;
  if (org.err && !org.data) return <ErrorBox>{org.err}</ErrorBox>;
  if (!org.data) return <Skeleton />;
  const o = org.data;
  if (!o.enabled) {
    return (
      <Callout icon={<ClockIcon size={26} />} title="The organisation view needs saved chat history">
        {o.note}
      </Callout>
    );
  }

  const usedNames = new Set(o.assistants_used.map((a) => a.name));
  const unused = agents.filter((a) => !usedNames.has(a.name));
  const perPerson = o.people ? o.questions / o.people : 0;

  return (
    <Dim busy={org.busy}>
      <div className="space-y-6">
        <ErrorBox>{org.err}</ErrorBox>
        <section className="card overflow-hidden">
          <div className="kpi-strip">
            <Kpi icon={<SparkleIcon size={16} />} label="Active people" value={fmt(o.people)} delta={{ cur: o.people, prev: o.previous.people, days }} />
            <Kpi icon={<MessageIcon size={16} />} label="Questions" value={fmt(o.questions)} delta={{ cur: o.questions, prev: o.previous.questions, days }} spark={o.per_day.map((d) => d.questions)} />
            <Kpi icon={<ArrowUpRightIcon size={16} />} label="New people" value={fmt(o.new_people)} hint="First question since history began" />
            <Kpi
              icon={<ThreadsIcon size={16} />}
              label="Per person"
              value={perPerson >= 10 ? fmt(Math.round(perPerson)) : perPerson.toFixed(1)}
              suffix="questions"
              hint="Average across active people"
            />
            <Kpi
              icon={<SparkleIcon size={16} />}
              label="Assistants in use"
              value={fmt(o.assistants_used.length)}
              suffix={agents.length ? `of ${agents.length}` : undefined}
              hint={unused.length ? `${unused.length} not used this period` : "All of them were used"}
            />
          </div>
        </section>

        {o.questions === 0 ? (
          <Callout icon={<SparkleIcon size={26} />} title={`Nobody asked anything in the last ${days} days`}>
            Try a longer period, or share an assistant with more people from the Admin console.
          </Callout>
        ) : (
          <>
            {/* Two measures on different scales: two charts, never one dual axis. */}
            <div className="grid gap-6 xl:grid-cols-2">
              <Panel title="Active people per day" sub="People who asked at least one question">
                <SeriesChart rows={o.per_day.map((d) => ({ day: d.day, value: d.people }))} one="person" many="people" height={160} />
              </Panel>
              <Panel title="Questions per day" sub="Across everyone">
                <SeriesChart rows={o.per_day.map((d) => ({ day: d.day, value: d.questions }))} one="question" height={160} />
              </Panel>
            </div>
            <Leaderboard rows={o.assistants_used} unused={unused} />
          </>
        )}

        <PeopleTable state={ppl} onPick={setWho} />
        <CostPerPerson days={days} />
      </div>
    </Dim>
  );
}

function Leaderboard({ rows, unused }: { rows: OrgOverview["assistants_used"]; unused: Agent[] }) {
  const [all, setAll] = useState(false);
  const max = Math.max(...rows.map((r) => r.questions), 1);
  const sum = rows.reduce((n, r) => n + r.questions, 0) || 1;
  const shown = all ? rows : rows.slice(0, 8);
  return (
    <Panel title="Assistants" sub="Which assistants people use, and how widely">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs faint" style={{ background: "var(--canvas)" }}>
              <th className="w-12 py-2.5 pl-6 pr-1 font-medium">#</th>
              <th className="px-3 py-2.5 font-medium">Assistant</th>
              <th className="min-w-[200px] px-3 py-2.5 font-medium">Questions</th>
              <th className="px-3 py-2.5 font-medium">People</th>
              <th className="px-3 py-2.5 pr-6 font-medium">Last used</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={r.name} style={{ borderTop: "1px solid var(--line)" }}>
                <td className="py-3 pl-6 pr-1 text-xs font-semibold faint tabular-nums">{i + 1}</td>
                <td className="max-w-[320px] px-3 py-3">
                  <span className="block truncate font-medium" title={r.label}>
                    {middleShort(r.label, 44)}
                  </span>
                </td>
                <td className="px-3 py-3">
                  <div className="flex items-center gap-3">
                    <span className="w-12 text-right font-semibold tabular-nums">{fmt(r.questions)}</span>
                    <div className="h-1.5 min-w-[80px] flex-1 overflow-hidden rounded-full" style={{ background: "var(--bubble)" }}>
                      <div className="h-full rounded-full" style={{ width: `${Math.max(2, (r.questions / max) * 100)}%`, background: "var(--chart-1)" }} />
                    </div>
                    <span className="w-9 text-right text-xs faint tabular-nums">{Math.round((r.questions / sum) * 100)}%</span>
                  </div>
                </td>
                <td className="px-3 py-3 tabular-nums muted">{fmt(r.people)}</td>
                <td className="whitespace-nowrap px-3 py-3 pr-6 muted">{r.last_used ? whenAgo(r.last_used) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 8 ? (
        <div className="border-t px-6 py-2.5" style={{ borderColor: "var(--line)" }}>
          <button type="button" className="text-[13px] font-medium" style={{ color: "var(--brand-deep)" }} onClick={() => setAll(!all)}>
            {all ? "Show top 8" : `Show all ${rows.length}`}
          </button>
        </div>
      ) : null}
      {unused.length ? (
        <div className="border-t px-6 py-4" style={{ borderColor: "var(--line)" }}>
          <p className="text-[13px] font-semibold">Not used in this period ({unused.length})</p>
          <p className="mt-0.5 text-xs faint">Worth sharing with more people, explaining better, or retiring.</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {unused.slice(0, 24).map((a) => (
              <span key={a.name} className="cap max-w-[260px]" title={a.display_name}>
                <span className="truncate">{middleShort(a.display_name, 34)}</span>
              </span>
            ))}
            {unused.length > 24 ? <span className="cap">+{unused.length - 24} more</span> : null}
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

function PeopleTable({
  state,
  onPick,
}: {
  state: { data: { enabled: boolean; note: string; people: PersonRow[] } | null; err: string; busy: boolean };
  onPick: (user: string) => void;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "questions", desc: true });
  const [limit, setLimit] = useState(PEOPLE_PAGE);
  useEffect(() => setLimit(PEOPLE_PAGE), [q, sort]);

  const list = state.data?.people || [];
  const ranked = useMemo(() => {
    const s = q.trim().toLowerCase();
    const rows = list.filter((p) => !s || p.user.toLowerCase().includes(s) || nameOf(p.user).toLowerCase().includes(s));
    const val = (p: PersonRow) => (sort.key === "last_active" ? Date.parse(p.last_active) || 0 : p[sort.key]);
    return [...rows].sort((a, b) => (sort.desc ? val(b) - val(a) : val(a) - val(b)));
  }, [list, q, sort]);
  const max = Math.max(...list.map((p) => p.questions), 1);
  const shown = ranked.slice(0, limit);

  function head(key: SortKey, label: string, cls = "") {
    const active = sort.key === key;
    return (
      <th className={`px-3 py-2.5 font-medium ${cls}`} aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}>
        <button
          type="button"
          className={`inline-flex items-center gap-1 transition hover:text-[var(--ink)] ${active ? "text-[var(--ink)]" : ""}`}
          onClick={() => setSort({ key, desc: active ? !sort.desc : true })}
        >
          {label}
          <span aria-hidden className="text-[10px]">
            {active ? (sort.desc ? "▼" : "▲") : ""}
          </span>
        </button>
      </th>
    );
  }

  return (
    <Panel
      title="People"
      sub="Pick a person to see their numbers. Click a column to sort."
      right={
        list.length > 6 ? (
          <label className="field flex w-full items-center gap-2 !py-0 sm:w-64">
            <span className="faint">
              <SearchIcon size={16} />
            </span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find a person"
              aria-label="Find a person"
              className="min-h-[36px] w-full bg-transparent outline-none"
            />
          </label>
        ) : null
      }
    >
      {state.err && !state.data ? (
        <div className="p-5">
          <ErrorBox>{state.err}</ErrorBox>
        </div>
      ) : !state.data ? (
        <Quiet>Loading…</Quiet>
      ) : list.length === 0 ? (
        <Quiet>Nobody has asked anything in this period.</Quiet>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs faint" style={{ background: "var(--canvas)" }}>
                <th className="w-12 py-2.5 pl-6 pr-1 font-medium">#</th>
                <th className="px-3 py-2.5 font-medium">Person</th>
                {head("questions", "Questions", "min-w-[200px]")}
                {head("conversations", "Conversations")}
                {head("assistants", "Assistants")}
                {head("last_active", "Last active")}
                <th className="px-6 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center muted">
                    Nobody matches “{q}”.
                  </td>
                </tr>
              ) : null}
              {shown.map((p, i) => (
                <tr
                  key={p.user}
                  className="cursor-pointer transition hover:bg-[var(--canvas)]"
                  style={{ borderTop: "1px solid var(--line)" }}
                  onClick={() => onPick(p.user)}
                >
                  <td className="py-3 pl-6 pr-1 text-xs font-semibold faint tabular-nums">{i + 1}</td>
                  <td className="px-3 py-3">
                    <span className="flex max-w-[300px] items-center gap-3">
                      <span className="avatar" aria-hidden>
                        {initials(p.user)}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{nameOf(p.user) || p.user}</span>
                        <span className="block truncate text-xs faint">{p.user}</span>
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-3">
                      <span className="w-12 text-right font-semibold tabular-nums">{fmt(p.questions)}</span>
                      <div className="h-1.5 min-w-[80px] flex-1 overflow-hidden rounded-full" style={{ background: "var(--bubble)" }}>
                        <div className="h-full rounded-full" style={{ width: `${Math.max(2, (p.questions / max) * 100)}%`, background: "var(--chart-1)" }} />
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3 tabular-nums muted">{fmt(p.conversations)}</td>
                  <td className="px-3 py-3 tabular-nums muted">{p.assistants}</td>
                  <td className="whitespace-nowrap px-3 py-3 muted">{p.last_active ? when(p.last_active) : "—"}</td>
                  <td className="px-6 py-3 text-right">
                    <button
                      type="button"
                      className="btn btn-quiet !min-h-[32px] !px-3 !text-[13px]"
                      onClick={(e) => {
                        e.stopPropagation();
                        onPick(p.user);
                      }}
                    >
                      View
                      <ArrowRightIcon size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ranked.length > shown.length ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-3 text-xs faint" style={{ borderColor: "var(--line)" }}>
          <span>
            Showing {shown.length} of {ranked.length} people
          </span>
          <button type="button" className="btn btn-quiet !min-h-[32px] !text-[13px]" onClick={() => setLimit((l) => l + PEOPLE_PAGE)}>
            Show {Math.min(PEOPLE_PAGE, ranked.length - shown.length)} more
          </button>
        </div>
      ) : null}
    </Panel>
  );
}

/** One person's numbers, for admins: counts only. No conversations, files or
 *  hours - those stay private to the person. */
function Person({ user, days, onBack }: { user: string; days: number; onBack: () => void }) {
  const { data, err, busy } = usePeriod(() => api.dashPerson(user, days), [user, days]);
  const name = nameOf(user) || user;
  return (
    <div>
      <div className="card mb-6 flex flex-wrap items-center gap-4 p-4 pr-6">
        <button type="button" className="btn btn-quiet" onClick={onBack}>
          <ChevronLeftIcon size={16} />
          Everyone
        </button>
        <span className="hidden h-8 w-px sm:block" style={{ background: "var(--line)" }} aria-hidden />
        <span className="avatar !h-11 !w-11" aria-hidden>
          {initials(user)}
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold tracking-[-0.01em]">{name}</h2>
          <p className="truncate text-sm faint">{user}</p>
        </div>
      </div>
      {err && !data ? (
        <ErrorBox>{err}</ErrorBox>
      ) : !data ? (
        <Skeleton />
      ) : !data.enabled ? (
        <Callout icon={<ClockIcon size={26} />} title="Saved chat history is off">
          {data.note}
        </Callout>
      ) : data.questions === 0 ? (
        <Callout icon={<SparkleIcon size={26} />} title={`${name} asked nothing in the last ${days} days`}>
          Try a longer period.
        </Callout>
      ) : (
        <Dim busy={busy}>
          <div className="space-y-6">
            <Summary data={data} who={name} />
            <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <Panel title="Activity" sub={`Questions each day, last ${data.days} days`}>
                <SeriesChart rows={data.per_day.map((d) => ({ day: d.day, value: d.questions }))} one="question" />
              </Panel>
              <GoTo rows={data.top_assistants} byName={new Map()} />
            </div>
            <p className="text-xs faint">Counts only. What {name} asked, and their files, stay private to them.</p>
          </div>
        </Dim>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- cost -----

function money(n: number) {
  return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function CostPerPerson({ days }: { days: number }) {
  const { data, err, busy } = usePeriod(() => api.dashCosts(days), [days]);
  const [all, setAll] = useState(false);

  const rows: CostRow[] = data?.rows || [];
  const max = Math.max(...rows.map((r) => r.est_usd), 0.0001);
  const attributed = rows.reduce((n, r) => n + r.est_usd, 0);
  const shown = all ? rows : rows.slice(0, 10);

  return (
    <Panel
      title="Estimated cost per person"
      sub="Databricks bills per assistant, not per person. This shares each assistant’s real cost between the people who used it, by how many questions each asked. Use it to see roughly where the spend comes from, not as an exact bill."
      right={
        <span className="chip shrink-0" style={{ color: "var(--ink-dim)" }}>
          Estimate
        </span>
      }
    >
      <div className="px-5 py-5 sm:px-6" style={{ opacity: busy && data ? 0.55 : 1, transition: "opacity .15s" }}>
        <ErrorBox>{err}</ErrorBox>
        {!data && !err ? (
          <div className="h-24 animate-pulse rounded-lg" style={{ background: "var(--bubble)" }} aria-label="Working it out" />
        ) : data && !data.available ? (
          <p className="text-sm muted">{data.note}</p>
        ) : data ? (
          rows.length === 0 ? (
            <p className="text-sm muted">No cost could be matched to anyone in this period.</p>
          ) : (
            <>
              <dl className="mb-6 grid gap-3 sm:grid-cols-3">
                <CostTile label="Matched to people" value={money(attributed)} />
                <CostTile
                  label="Not from the portal"
                  value={money(data.unattributed_usd || 0)}
                  title="Spend on assistants nobody used through the portal in this period, or calls made outside it."
                />
                {data.total_usd != null ? <CostTile label="Total spend" value={money(data.total_usd)} /> : null}
              </dl>
              <ul className="space-y-4">
                {shown.map((r) => (
                  <li key={r.user} className="flex items-center gap-3">
                    <span className="avatar" aria-hidden>
                      {initials(r.user)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-[14.5px] font-medium" title={r.user}>
                          {nameOf(r.user) || r.user}
                        </span>
                        <span className="shrink-0 text-sm font-semibold tabular-nums">
                          ≈ {money(r.est_usd)}
                          <span className="ml-1.5 hidden text-xs font-normal faint sm:inline">{plural(r.questions, "question")}</span>
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--bubble)" }}>
                        <div className="h-full rounded-full" style={{ width: `${Math.max(2, (r.est_usd / max) * 100)}%`, background: "var(--chart-1)" }} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              {rows.length > 10 ? (
                <button type="button" className="mt-4 text-[13px] font-medium" style={{ color: "var(--brand-deep)" }} onClick={() => setAll(!all)}>
                  {all ? "Show top 10" : `Show all ${rows.length}`}
                </button>
              ) : null}
            </>
          )
        ) : null}
      </div>
    </Panel>
  );
}

function CostTile({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-xl px-4 py-3" style={{ background: "var(--canvas)", border: "1px solid var(--line)" }} title={title}>
      <dt className="text-xs faint">{label}</dt>
      <dd className="mt-1 text-[20px] font-semibold tracking-[-0.015em]">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------- dates -----

function parse(iso: string) {
  return new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
}

function shortDay(iso: string) {
  const d = parse(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function weekday(iso: string) {
  const d = parse(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { weekday: "short" });
}

function longDay(iso: string) {
  const d = parse(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "long" });
}

/** "today at 09:15", "yesterday at 16:40", or a date: how people say it. */
function when(iso: string) {
  const d = parse(iso);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (same(d, now)) return `today at ${time}`;
  if (same(d, y)) return `yesterday at ${time}`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** "5 min ago", "Yesterday", "12 Sep". */
function whenAgo(iso: string) {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return "Yesterday";
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
