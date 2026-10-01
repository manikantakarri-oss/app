"use client";

import { ReactNode, useEffect, useState } from "react";
import { Activity as ActivityData, api, CostRow, PersonRow } from "@/lib/api";
import { initials, nameOf } from "@/lib/people";
import { ErrorBox, Notice, Spinner } from "./bits";
import {
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  DownloadIcon,
  MessageIcon,
  SearchIcon,
  SparkleIcon,
  ThreadsIcon,
  UploadIcon,
} from "./icons";

/** "My dashboard": what you have done with the assistants, in numbers.
 *
 *  Everyone sees their own. Admins also get "Everyone": the people, any one
 *  person's numbers, and an estimated cost per person. Admins only ever see
 *  counts - what people asked stays private to them, and the screen says so.
 *
 *  The chart is questions per day: one measure over time, so one colour (the
 *  portal's validated chart token, not the brand teal), thin columns with a
 *  rounded top, recessive gridlines, a real y-axis, a hover read-out, and a table
 *  view as the accessible alternative. Headline cards carry the change against
 *  the previous period, always as an arrow AND a signed number, never colour alone.
 */
export function Dashboard({ isAdmin }: { isAdmin: boolean }) {
  const [view, setView] = useState<"me" | "everyone">("me");
  const [days, setDays] = useState(30);

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--brand-deep)" }}>
            {view === "me" ? "Your activity" : "Across the portal"}
          </p>
          <h1 className="mt-1 text-[28px] font-semibold leading-tight tracking-[-0.02em]">
            {view === "me" ? "My dashboard" : "Everyone’s activity"}
          </h1>
          <p className="mt-1.5 max-w-2xl text-[15px] muted">
            {view === "me"
              ? "What you have asked, and which assistants you rely on."
              : "How the assistants are being used, person by person. You see numbers only. What people asked stays private to them."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
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

      {view === "me" ? <Mine days={days} /> : <Everyone days={days} />}
    </div>
  );
}

// ---------------------------------------------------------------- mine ------

function Mine({ days }: { days: number }) {
  const [data, setData] = useState<ActivityData | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setData(null);
    setErr("");
    api.dashMe(days).then(setData).catch((e) => setErr(e.message));
  }, [days]);
  if (err) return <ErrorBox>{err}</ErrorBox>;
  if (!data) return <Skeleton />;
  return <ActivityView data={data} mine />;
}

function Skeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))] sm:gap-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="card h-[132px] animate-pulse" />
        ))}
      </div>
      <div className="card h-[320px] animate-pulse" />
    </div>
  );
}

function ActivityView({ data, mine }: { data: ActivityData; mine?: boolean }) {
  if (!data.enabled) return <Notice>{data.note}</Notice>;

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))] sm:gap-4">
        <Kpi
          icon={<MessageIcon size={20} />}
          label="Questions asked"
          value={data.questions}
          delta={{ cur: data.questions, prev: data.previous?.questions, days: data.days }}
        />
        <Kpi
          icon={<ThreadsIcon size={20} />}
          label="Conversations"
          value={data.conversations}
          delta={{ cur: data.conversations, prev: data.previous?.conversations, days: data.days }}
        />
        <Kpi icon={<SparkleIcon size={20} />} label="Assistants used" value={data.assistants} />
        <Kpi icon={<UploadIcon size={20} />} label="Files sent" value={data.files_sent} />
        <Kpi icon={<DownloadIcon size={20} />} label="Files received" value={data.files_back} />
      </div>

      {data.questions === 0 ? (
        <div className="card px-6 py-14 text-center">
          <span className="avatar mx-auto !h-12 !w-12" aria-hidden>
            <SparkleIcon size={22} />
          </span>
          <p className="mt-4 text-base font-semibold">
            {mine ? "Nothing yet in this period" : "No questions in this period"}
          </p>
          {mine ? (
            <p className="mx-auto mt-1.5 max-w-md text-[15px] muted">
              Open “Your assistants”, pick one and ask it something. Your activity will appear here.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="card p-6">
            <PerDay days={data.per_day} />
          </div>
          <div className="card p-6">
            <TopAssistants rows={data.top_assistants} />
          </div>
        </div>
      )}

      <p className="text-xs faint">
        Counted from saved chats, so it only includes conversations since saved history was turned on.
        {data.last_active ? ` Last active ${when(data.last_active)}.` : ""}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------- kpi ----

function Kpi({
  icon,
  label,
  value,
  delta,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  delta?: { cur: number; prev?: number; days: number };
}) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="avatar !h-10 !w-10" aria-hidden>
          {icon}
        </span>
        {delta ? <Delta {...delta} /> : null}
      </div>
      <p className="mt-4 text-[34px] font-semibold leading-none tracking-[-0.02em] tabular-nums">
        {value.toLocaleString()}
      </p>
      <p className="mt-2 text-sm muted">{label}</p>
    </div>
  );
}

/** Change against the period just before. An arrow and a signed number, so the
 *  direction never depends on colour. A fall is neutral grey rather than red:
 *  using the assistants less is not an error. */
function Delta({ cur, prev, days }: { cur: number; prev?: number; days: number }) {
  if (prev == null || (cur === 0 && prev === 0)) return null;
  const title = `Compared with the previous ${days} days (${prev.toLocaleString()})`;
  if (prev === 0) {
    return (
      <span className="chip" style={{ color: "var(--ok)" }} title={title}>
        <ArrowUpRightIcon size={14} /> New
      </span>
    );
  }
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) {
    return (
      <span className="chip" style={{ color: "var(--ink-dim)" }} title={title}>
        No change
      </span>
    );
  }
  const up = pct > 0;
  return (
    <span className="chip" style={{ color: up ? "var(--ok)" : "var(--ink-dim)" }} title={title}>
      {up ? <ArrowUpRightIcon size={14} /> : <ArrowDownRightIcon size={14} />}
      {up ? "+" : "−"}
      {Math.abs(pct)}%
    </span>
  );
}

// -------------------------------------------------------------- per day -----

/** A round maximum for the y-axis: 4, 5, 8, 10, 20, 50 ... */
function niceMax(n: number) {
  if (n <= 4) return 4;
  const p = Math.pow(10, Math.floor(Math.log10(n)));
  for (const m of [1, 2, 5, 10]) if (n <= m * p) return m * p;
  return 10 * p;
}

function PerDay({ days }: { days: { day: string; questions: number }[] }) {
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const top = niceMax(Math.max(...days.map((d) => d.questions), 1));
  const total = days.reduce((n, d) => n + d.questions, 0);
  const busiest = days.reduce((b, d) => (d.questions > b.questions ? d : b), days[0]);
  const avg = total / days.length;
  const H = 180;
  const n = days.length;
  const labelIdx = n <= 7 ? days.map((_, i) => i) : [0, 1, 2, 3, 4].map((k) => Math.round((k * (n - 1)) / 4));

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Questions per day</h2>
          <p className="mt-0.5 text-sm muted">The last {n} days</p>
        </div>
        <button type="button" className="text-sm muted underline underline-offset-2 hover:text-[var(--ink)]" onClick={() => setAsTable(!asTable)}>
          {asTable ? "Show chart" : "Show as table"}
        </button>
      </div>

      <dl className="mt-4 flex flex-wrap gap-x-10 gap-y-3">
        <Stat label="Total" value={total.toLocaleString()} />
        <Stat label="Daily average" value={avg >= 10 ? Math.round(avg).toString() : avg.toFixed(1)} />
        <Stat label="Busiest day" value={busiest.questions ? `${shortDay(busiest.day)} · ${busiest.questions}` : "—"} />
      </dl>

      {asTable ? (
        <div className="mt-5 max-h-80 overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs faint">
                <th className="py-2 pr-3 font-medium">Day</th>
                <th className="py-2 font-medium">Questions</th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.day} style={{ borderTop: "1px solid var(--line)" }}>
                  <td className="py-2 pr-3">{longDay(d.day)}</td>
                  <td className="py-2 tabular-nums">{d.questions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-6">
          <div className="flex gap-3">
            {/* y-axis: three round numbers, in muted text. */}
            <div className="relative w-7 shrink-0 text-right text-[11px] faint tabular-nums" style={{ height: H }} aria-hidden>
              {[1, 0.5, 0].map((f) => (
                <span key={f} className="absolute right-0 -translate-y-1/2" style={{ top: (1 - f) * (H - 1) }}>
                  {Math.round(top * f)}
                </span>
              ))}
            </div>

            <div className="relative min-w-0 flex-1" style={{ height: H }} onMouseLeave={() => setHover(null)}>
              {[0, 0.5, 1].map((f) => (
                <div
                  key={f}
                  aria-hidden
                  className="absolute left-0 right-0"
                  style={{ top: (1 - f) * (H - 1), borderTop: "1px solid var(--line)" }}
                />
              ))}

              <div className="absolute inset-0 flex items-end gap-[3px]">
                {days.map((d, i) => (
                  <div
                    key={d.day}
                    className="flex h-full min-w-0 flex-1 items-end justify-center"
                    onMouseEnter={() => setHover(i)}
                    title={`${longDay(d.day)}: ${d.questions}`}
                  >
                    <div
                      style={{
                        width: "100%",
                        maxWidth: 26,
                        height: d.questions ? Math.max(3, (d.questions / top) * (H - 1)) : 0,
                        background: "var(--chart-1)",
                        // 4px rounded data-end, square at the baseline.
                        borderRadius: "4px 4px 0 0",
                        opacity: hover === null || hover === i ? 1 : 0.5,
                        transition: "opacity .12s",
                      }}
                    />
                  </div>
                ))}
              </div>

              {hover !== null ? (
                <div
                  role="status"
                  className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-lg px-3 py-2 text-xs"
                  style={{
                    left: `${Math.min(88, Math.max(12, ((hover + 0.5) / n) * 100))}%`,
                    top: Math.max(0, (1 - days[hover].questions / top) * (H - 1) - 54),
                    background: "var(--ink)",
                    color: "var(--canvas)",
                    boxShadow: "var(--shadow-lg)",
                  }}
                >
                  <span className="block opacity-70">{longDay(days[hover].day)}</span>
                  <span className="block text-sm font-semibold tabular-nums">
                    {days[hover].questions} {days[hover].questions === 1 ? "question" : "questions"}
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-2 flex justify-between pl-10 text-xs faint">
            {labelIdx.map((i) => (
              <span key={i}>{n <= 7 ? weekday(days[i].day) : shortDay(days[i].day)}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs faint">{label}</dt>
      <dd className="mt-0.5 text-[17px] font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

// ----------------------------------------------------------- top assistants -

function TopAssistants({ rows }: { rows: ActivityData["top_assistants"] }) {
  const max = Math.max(...rows.map((r) => r.questions), 1);
  const sum = rows.reduce((n, r) => n + r.questions, 0) || 1;
  return (
    <div>
      <h2 className="text-base font-semibold">Most used assistants</h2>
      <p className="mt-0.5 text-sm muted">By number of questions</p>
      <ul className="mt-5 space-y-4">
        {rows.map((r, i) => (
          <li key={r.name} className="flex items-center gap-3">
            <span className="avatar !h-9 !w-9 !text-xs" aria-hidden>
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-[15px] font-medium" title={r.label}>
                  {r.label}
                </span>
                <span className="shrink-0 text-sm tabular-nums">
                  {r.questions.toLocaleString()} <span className="faint">· {Math.round((r.questions / sum) * 100)}%</span>
                </span>
              </div>
              <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--bubble)" }}>
                <div className="h-full rounded-full" style={{ width: `${Math.max(2, (r.questions / max) * 100)}%`, background: "var(--chart-1)" }} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------- everyone -----

function Everyone({ days }: { days: number }) {
  const [people, setPeople] = useState<{ enabled: boolean; note: string; people: PersonRow[] } | null>(null);
  const [err, setErr] = useState("");
  const [who, setWho] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    setPeople(null);
    setErr("");
    api.dashPeople(days).then(setPeople).catch((e) => setErr(e.message));
  }, [days]);

  if (who) return <Person user={who} days={days} onBack={() => setWho(null)} />;
  if (err) return <ErrorBox>{err}</ErrorBox>;
  if (!people) return <Skeleton />;
  if (!people.enabled) return <Notice>{people.note}</Notice>;

  const list = people.people;
  const totalQ = list.reduce((n, p) => n + p.questions, 0);
  const totalC = list.reduce((n, p) => n + p.conversations, 0);
  const max = Math.max(...list.map((p) => p.questions), 1);
  const shown = list.filter((p) => !q.trim() || p.user.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="space-y-10">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))] sm:gap-4">
        <Kpi icon={<SparkleIcon size={20} />} label="People who asked something" value={list.length} />
        <Kpi icon={<MessageIcon size={20} />} label="Questions asked" value={totalQ} />
        <Kpi icon={<ThreadsIcon size={20} />} label="Conversations" value={totalC} />
        <Kpi
          icon={<MessageIcon size={20} />}
          label="Questions per person"
          value={list.length ? Math.round(totalQ / list.length) : 0}
        />
      </div>

      <section>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-[-0.01em]">People</h2>
            <p className="mt-0.5 text-sm muted">Ranked by questions asked. Pick a person to see their numbers.</p>
          </div>
          {list.length > 6 ? (
            <label className="relative block w-full sm:w-72">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 faint">
                <SearchIcon size={18} />
              </span>
              <input
                className="field !pl-10"
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Find a person"
                aria-label="Find a person"
              />
            </label>
          ) : null}
        </div>

        {list.length === 0 ? (
          <div className="card px-6 py-12 text-center text-[15px] muted">Nobody has asked anything in this period.</div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-medium faint" style={{ background: "var(--canvas)" }}>
                  <th className="px-5 py-3 font-medium">Person</th>
                  <th className="min-w-[200px] px-3 py-3 font-medium">Questions</th>
                  <th className="px-3 py-3 font-medium">Conversations</th>
                  <th className="px-3 py-3 font-medium">Assistants</th>
                  <th className="px-3 py-3 font-medium">Last active</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-8 text-center muted">
                      Nobody matches “{q}”.
                    </td>
                  </tr>
                ) : null}
                {shown.map((p) => (
                  <tr key={p.user} className="transition hover:bg-[var(--canvas)]" style={{ borderTop: "1px solid var(--line)" }}>
                    <td className="px-5 py-3">
                      <button type="button" className="flex max-w-[280px] items-center gap-3 text-left" onClick={() => setWho(p.user)}>
                        <span className="avatar" aria-hidden>
                          {initials(p.user)}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{nameOf(p.user) || p.user}</span>
                          <span className="block truncate text-xs faint">{p.user}</span>
                        </span>
                      </button>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-3">
                        <span className="w-10 text-right font-medium tabular-nums">{p.questions.toLocaleString()}</span>
                        <div className="h-2 min-w-[80px] flex-1 overflow-hidden rounded-full" style={{ background: "var(--bubble)" }}>
                          <div className="h-full rounded-full" style={{ width: `${Math.max(2, (p.questions / max) * 100)}%`, background: "var(--chart-1)" }} />
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3 tabular-nums muted">{p.conversations.toLocaleString()}</td>
                    <td className="px-3 py-3 tabular-nums muted">{p.assistants}</td>
                    <td className="whitespace-nowrap px-3 py-3 muted">{p.last_active ? when(p.last_active) : "—"}</td>
                    <td className="px-5 py-3 text-right">
                      <button type="button" className="btn btn-quiet !min-h-[36px] !px-3" onClick={() => setWho(p.user)}>
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <CostPerPerson days={days} />
    </div>
  );
}

function Person({ user, days, onBack }: { user: string; days: number; onBack: () => void }) {
  const [data, setData] = useState<ActivityData | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setData(null);
    setErr("");
    api.dashPerson(user, days).then(setData).catch((e) => setErr(e.message));
  }, [user, days]);
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <button type="button" className="btn btn-quiet" onClick={onBack}>
          ← Everyone
        </button>
        <span className="avatar !h-11 !w-11" aria-hidden>
          {initials(user)}
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-xl font-semibold tracking-[-0.01em]">{nameOf(user) || user}</h2>
          <p className="truncate text-sm faint">{user}</p>
        </div>
      </div>
      {err ? <ErrorBox>{err}</ErrorBox> : !data ? <Skeleton /> : <ActivityView data={data} />}
    </div>
  );
}

// ----------------------------------------------------------------- cost -----

function CostPerPerson({ days }: { days: number }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.dashCosts>> | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setData(null);
    setErr("");
    api.dashCosts(days).then(setData).catch((e) => setErr(e.message));
  }, [days]);

  const rows: CostRow[] = data?.rows || [];
  const max = Math.max(...rows.map((r) => r.est_usd), 0.0001);
  const attributed = rows.reduce((n, r) => n + r.est_usd, 0);

  return (
    <section>
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold tracking-[-0.01em]">Estimated cost per person</h2>
        <span className="chip" style={{ color: "var(--ink-dim)" }}>
          Estimate
        </span>
      </div>
      <p className="mb-4 max-w-3xl text-sm muted">
        Databricks bills per assistant, not per person. This shares each assistant’s real cost between the people
        who used it, in proportion to how many questions each asked it. Use it to see roughly where the spend
        comes from, not as an exact bill.
      </p>

      <div className="card p-6">
        <ErrorBox>{err}</ErrorBox>
        {!data && !err ? (
          <Spinner label="Working it out…" />
        ) : data && !data.available ? (
          <p className="text-sm muted">{data.note}</p>
        ) : data ? (
          rows.length === 0 ? (
            <p className="text-sm muted">No cost could be matched to anyone in this period.</p>
          ) : (
            <>
              <dl className="mb-6 flex flex-wrap gap-x-12 gap-y-3">
                <Stat label="Matched to people" value={`$${attributed.toFixed(2)}`} />
                {data.unattributed_usd ? (
                  <div title="Spend on assistants nobody used through the portal in this period, or calls made outside it.">
                    <dt className="text-xs faint">Not from the portal</dt>
                    <dd className="mt-0.5 text-[17px] font-semibold tabular-nums">${data.unattributed_usd.toFixed(2)}</dd>
                  </div>
                ) : null}
                {data.total_usd != null ? <Stat label="Total spend" value={`$${data.total_usd.toFixed(2)}`} /> : null}
              </dl>
              <ul className="space-y-4">
                {rows.map((r) => (
                  <li key={r.user} className="flex items-center gap-3">
                    <span className="avatar" aria-hidden>
                      {initials(r.user)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-[15px] font-medium" title={r.user}>
                          {nameOf(r.user) || r.user}
                        </span>
                        <span className="shrink-0 text-sm tabular-nums">
                          ≈ ${r.est_usd.toFixed(2)} <span className="faint">· {r.questions} questions</span>
                        </span>
                      </div>
                      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--bubble)" }}>
                        <div className="h-full rounded-full" style={{ width: `${Math.max(2, (r.est_usd / max) * 100)}%`, background: "var(--chart-1)" }} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )
        ) : null}
      </div>
    </section>
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
