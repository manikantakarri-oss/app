"use client";

import { useEffect, useState } from "react";
import { AdminAgent, api } from "@/lib/api";
import { CostChart } from "./CostChart";
import { CardList, ErrorBox, Notice, SectionHead, Spinner, StatusDot } from "./bits";
import { middleShort } from "@/lib/people";
import { Activity } from "./Activity";
import { Logs } from "./Logs";

type Overview = Awaited<ReturnType<typeof api.adminOverview>>;

export function Admin() {
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [openName, setOpenName] = useState<string | null>(null);
  const [view, setView] = useState("access");

  async function load() {
    setErr("");
    try {
      setData(await api.adminOverview());
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  const open = data?.agents.find((a) => a.name === openName) || null;

  // Same shape as the agents tab: a grid of cards, then a detail view. One
  // interaction model to learn instead of two, and it still reads at twenty
  // agents where stacked full-width panels would not.
  if (open && data) {
    return (
      <AgentDetail agent={open} data={data} onBack={() => setOpenName(null)} reload={load} />
    );
  }

  return (
    <div>
      <div
        className="mb-7 inline-flex max-w-full flex-wrap gap-1 rounded-xl p-1"
        style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
        role="tablist"
        aria-label="Admin sections"
      >
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            role="tab"
            aria-selected={view === v.key}
            onClick={() => setView(v.key)}
            className="rounded-lg px-4 py-2 text-sm transition"
            style={
              view === v.key
                ? { background: "var(--brand)", color: "var(--brand-ink)", fontWeight: 600 }
                : { color: "var(--ink-dim)" }
            }
          >
            {v.label}
          </button>
        ))}
      </div>

      {view === "access" ? (
        <div>
          <SectionHead title="Who can use each assistant">
            Pick an assistant to see who can use it and to change that. Changes are saved straight
            away.
          </SectionHead>
          <ErrorBox>{err}</ErrorBox>
          {loading ? (
            <Spinner label="Loading…" />
          ) : !data?.agents.length ? (
            <p className="text-sm muted">No assistants have been shared with the portal yet.</p>
          ) : (
            <CardList
              items={data.agents}
              noun="assistants"
              keyOf={(a) => a.name}
              text={(a) => `${a.display_name} ${a.name} ${a.blurb || ""}`}
              render={(a) => <AgentTile agent={a} onOpen={() => setOpenName(a.name)} />}
            />
          )}
        </div>
      ) : null}

      {view === "costs" ? <Spending /> : null}
      {view === "activity" ? <Activity /> : null}
      {view === "problems" ? <Logs /> : null}
    </div>
  );
}

const VIEWS = [
  { key: "access", label: "People & access" },
  { key: "costs", label: "Costs" },
  { key: "activity", label: "Activity" },
  { key: "problems", label: "Problems" },
];

function AgentTile({ agent, onOpen }: { agent: AdminAgent; onOpen: () => void }) {
  const people = agent.grants.filter(
    (g) => (g.level === "CAN_QUERY" || g.level === "CAN_MANAGE") && g.kind !== "service_principal"
  );
  const readOnly = agent.you_can_manage === false;

  return (
    <button
      type="button"
      onClick={onOpen}
      title={agent.display_name}
      className="card flex w-full flex-col p-5 text-left transition hover:border-[var(--brand)]"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="line-clamp-2 text-base font-semibold leading-snug">{middleShort(agent.display_name)}</h3>
        {readOnly ? <span className="tag shrink-0 whitespace-nowrap">View only</span> : null}
      </div>

      <p className="mt-1.5 text-sm muted">
        {agent.acl_error
          ? "Not shared with the portal yet"
          : people.length === 0
            ? "Nobody can use it yet"
            : `${people.length} ${
                people.length === 1 ? "person or team can" : "people and teams can"
              } use it`}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs faint">
        <span className="inline-flex items-center gap-1.5">
          <StatusDot ok={agent.ready} />
          {agent.ready ? "Ready" : "Starting up"}
        </span>
        {agent.supports_files ? <span>Accepts files</span> : null}
      </div>
    </button>
  );
}

function AgentDetail({
  agent,
  data,
  onBack,
  reload,
}: {
  agent: AdminAgent;
  data: Overview;
  onBack: () => void;
  reload: () => void;
}) {
  const [kind, setKind] = useState<"group" | "user">("group");
  const [who, setWho] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const readOnly = agent.you_can_manage === false;
  const options = kind === "group" ? data.groups : data.users;

  useEffect(() => {
    const first = kind === "group" ? data.groups[0]?.name : data.users[0]?.name;
    setWho(first || "");
  }, [kind, data]);

  async function give() {
    if (!who || !agent.id) return;
    setBusy(true);
    setErr("");
    try {
      const res = await api.grant(agent.id, kind, who, "CAN_QUERY");
      if (res?.warning) setErr(res.warning);
      reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function take(principal: string, pKind: string) {
    if (!agent.id) return;
    setBusy(true);
    setErr("");
    try {
      await api.grant(agent.id, pKind, principal, null);
      reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const usable = agent.grants.filter((g) => g.level === "CAN_QUERY" || g.level === "CAN_MANAGE");

  return (
    <div>
      <div className="mb-5 flex items-start gap-3">
        <button type="button" onClick={onBack} className="btn btn-quiet shrink-0">
          ← All assistants
        </button>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{agent.display_name}</h2>
          <p className="text-sm muted">{agent.blurb || agent.name}</p>
        </div>
      </div>

      <ErrorBox>{err}</ErrorBox>

      {agent.acl_error ? (
        <ErrorBox>{agent.acl_error}</ErrorBox>
      ) : (
        <>
          {readOnly ? (
            <div className="mb-4">
              <Notice>
                You can see this list but not change it, because you do not have Manage permission
                on this assistant in Databricks. Its owner can give you that.
              </Notice>
            </div>
          ) : null}

          <div className="card p-5">
            <h3 className="text-base font-semibold">Let someone use this assistant</h3>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                className="field w-auto"
                aria-label="A team or one person"
                value={kind}
                onChange={(e) => setKind(e.target.value as "group" | "user")}
                disabled={readOnly}
              >
                <option value="group">A team (group)</option>
                <option value="user">One person</option>
              </select>
              <select
                className="field w-auto min-w-[220px] flex-1"
                aria-label="Who to give access to"
                value={who}
                onChange={(e) => setWho(e.target.value)}
                disabled={readOnly}
              >
                {options.map((o: any) => (
                  <option key={o.name} value={o.name}>
                    {kind === "group" ? o.name : `${o.display} (${o.name})`}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-primary"
                onClick={give}
                disabled={readOnly || busy || !who}
              >
                Give access
              </button>
            </div>
          </div>

          <div className="card mt-4 p-5">
            <h3 className="text-base font-semibold">Who can use it now</h3>
            {usable.length === 0 ? (
              <p className="mt-3 text-sm muted">Nobody yet. Add a team or a person above.</p>
            ) : (
              <ul className="mt-2">
                {usable.map((g) => (
                  <li
                    key={`${g.kind}:${g.principal}:${g.level}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5"
                    style={{ borderTop: "1px solid var(--line)" }}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">{g.principal}</span>
                    <span className="text-xs faint">
                      {g.kind === "service_principal" ? "app" : g.kind === "group" ? "team" : g.kind === "user" ? "person" : g.kind}
                    </span>
                    <span className="text-sm muted">
                      {g.level === "CAN_MANAGE" ? "Can use and manage" : "Can use"}
                      {g.inherited ? " (inherited)" : ""}
                    </span>
                    {g.kind !== "service_principal" && !g.inherited && !readOnly ? (
                      <button
                        type="button"
                        className="btn btn-quiet"
                        onClick={() => take(g.principal, g.kind)}
                        disabled={busy}
                      >
                        Remove
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Appearance agent={agent} readOnly={readOnly} reload={reload} onError={setErr} />
        </>
      )}
    </div>
  );
}

function Appearance({
  agent,
  readOnly,
  reload,
  onError,
}: {
  agent: AdminAgent;
  readOnly: boolean;
  reload: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState(agent.display_name);
  const [blurb, setBlurb] = useState(agent.blurb);
  const [vol, setVol] = useState(agent.upload_volume);
  const [outVol, setOutVol] = useState(agent.output_volume);
  const [accepts, setAccepts] = useState((agent.accepts || []).join(", "));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setSaved(false);
    onError("");
    try {
      await api.meta({
        name: agent.name,
        display_name: name,
        blurb,
        upload_volume: vol,
        output_volume: outVol,
        accepts,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
      reload();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mt-4 p-5">
      <h3 className="text-base font-semibold">Name, description and files</h3>
      <p className="mt-1 text-sm muted">What people see, and what the assistant can take and give back.</p>
      <div className="mt-4 space-y-4">
        <Row label="Name people see">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
        </Row>
        <Row label="Short description">
          <input className="field" value={blurb} onChange={(e) => setBlurb(e.target.value)} />
        </Row>
        <Row
          label="Where files people send are kept"
          hint="Only if the assistant reads files. Write it as catalog.schema.volume."
        >
          <input
            className="field"
            placeholder="catalog.schema.volume"
            value={vol}
            onChange={(e) => setVol(e.target.value)}
          />
        </Row>
        <Row
          label="Where files it makes are saved"
          hint="Only if it creates files people should download. Only files here can be downloaded. Write it as catalog.schema.volume."
        >
          <input
            className="field"
            placeholder="catalog.schema.volume"
            value={outVol}
            onChange={(e) => setOutVol(e.target.value)}
          />
        </Row>
        <Row label="File types allowed" hint="Leave blank to allow any file. For example: xlsx, csv">
          <input
            className="field"
            placeholder="xlsx, csv"
            value={accepts}
            onChange={(e) => setAccepts(e.target.value)}
          />
        </Row>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={readOnly || busy}
          >
            {busy ? "Saving…" : "Save these settings"}
          </button>
          {saved ? (
            <span className="text-sm font-medium" style={{ color: "var(--ok)" }} role="status">
              ✓ Saved
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint ? <span className="help block">{hint}</span> : null}
    </label>
  );
}

function Spending() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.cost>> | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    setData(null);
    setErr("");
    api.cost(days).then(setData).catch((e) => setErr(e.message));
  }, [days]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-[-0.01em]">What the AI has cost</h2>
          <p className="mt-1 max-w-2xl text-sm muted">
            How much each assistant and AI model has cost, taken from your workspace&apos;s own
            billing records.
          </p>
        </div>
        <select
          className="field w-auto text-sm"
          aria-label="Time period"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      <div className="card p-5">
        <ErrorBox>{err}</ErrorBox>
        {data === null ? (
          <Spinner label="Loading…" />
        ) : !data.available ? (
          <p className="text-sm muted">Cost figures are not available. {data.note}</p>
        ) : (
          <>
            <CostChart lines={data.lines} total={data.total_usd} days={data.days} />
            <p className="mt-4 text-xs faint">
              Supervisor agents appear as their own line (named by their endpoint). Other agents are
              charged to whichever model they run on, so their cost is included in that model&apos;s
              line.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
