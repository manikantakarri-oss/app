"use client";

import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClientDetail, ClientForm, dapi, DeployRow, HealthRow, Release } from "@/lib/deployer";
import { Card, Chips, Pre, Quiet, Tag } from "@/components/Ops";
import { Kpi } from "@/components/Dashboard";
import { ErrorBox, Notice, Pager, Select, Spinner, usePage } from "@/components/bits";
import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronLeftIcon,
  CloseIcon,
  PulseIcon,
  RefreshIcon,
  RocketIcon,
  TagIcon,
  UndoIcon,
} from "@/components/icons";
import { ago, DeployTag, ExtLink, Field, HealthTag, hostLabel, OpenRow, PageHead, person, verb, Version, when } from "./parts";

const FINAL = ["succeeded", "failed", "rolled_back"];
const POLL_MS = 4000;

/** One client: what it runs, deploy or roll back, watch it happen, and its
 *  full history. Everything shown comes from the deployment record and GitHub. */
export function ClientPage({
  id,
  releases,
  onBack,
  onChanged,
  onRemoved,
}: {
  id: string;
  releases: Release[] | null;
  onBack: () => void;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const [c, setC] = useState<ClientDetail | null>(null);
  const [err, setErr] = useState("");
  const [watch, setWatch] = useState("");

  const load = useCallback(() => {
    dapi
      .client(id)
      .then((d) => {
        setC(d);
        setErr("");
        if (d.in_progress) setWatch(d.in_progress.deploy_id);
      })
      .catch((e) => setErr(e.message));
  }, [id]);

  useEffect(() => {
    setC(null);
    setWatch("");
    load();
  }, [load]);

  const current = c?.version || "";
  const rollbackTo = useMemo(
    () => c?.deploys.find((d) => d.status === "succeeded" && d.version && d.version !== current)?.version || "",
    [c, current]
  );

  if (err && !c) {
    return (
      <>
        <BackLink onBack={onBack} />
        <ErrorBox>{err}</ErrorBox>
      </>
    );
  }
  if (!c) {
    return (
      <>
        <BackLink onBack={onBack} />
        <div className="space-y-6" aria-busy>
          <div className="h-16 w-1/2 animate-pulse rounded-xl" style={{ background: "var(--bubble)" }} />
          <div className="card h-[132px] animate-pulse" />
          <div className="card h-[220px] animate-pulse" />
        </div>
      </>
    );
  }

  const h = c.health;
  const url = h?.detail?.url || c.last_deploy?.detail?.url || "";
  return (
    <>
      <BackLink onBack={onBack} />
      <PageHead
        eyebrow="Client"
        title={c.name}
        text={
          <>
            <ExtLink href={c.host}>{c.host ? hostLabel(c.host) : "Workspace not set"}</ExtLink>
            <span className="faint"> · app </span>
            <span className="font-mono text-[13px]">{c.app_name}</span>
          </>
        }
        actions={
          url ? (
            <a className="btn btn-quiet" href={url} target="_blank" rel="noreferrer">
              Open portal
              <ArrowUpRightIcon size={15} />
            </a>
          ) : null
        }
      />
      {err ? (
        <div className="mb-5">
          <ErrorBox>{err}</ErrorBox>
        </div>
      ) : null}
      {!c.ready || !c.secret_set_at ? (
        <div className="mb-5">
          <Notice>This client&apos;s settings are incomplete. Add the workspace address, the application id and the secret under Settings below before deploying.</Notice>
        </div>
      ) : null}

      <div className="space-y-6">
        <section className="card overflow-hidden">
          <div className="kpi-strip">
            <Kpi icon={<TagIcon size={16} />} label="Version" value={current || "None"} hint={current ? `Live since ${ago(c.deploys.find((d) => d.status === "succeeded")?.at)}` : "Not deployed yet"} />
            <Kpi
              icon={<PulseIcon size={16} />}
              label="Health"
              value={h ? ({ healthy: "Healthy", degraded: "Degraded", down: "Down", unverified: "Running" } as Record<string, string>)[h.status] || h.status : "Unknown"}
              hint={h ? `Checked ${ago(h.at)}` : "Never checked"}
            />
            <Kpi
              icon={<RocketIcon size={16} />}
              label="Deploys"
              value={String(c.deploys.filter((d) => d.action !== "auto_rollback").length)}
              hint={c.deploys.length ? `${c.deploys.filter((d) => d.status === "failed" || d.status === "rolled_back").length} failed or rolled back` : "None yet"}
            />
            <Kpi
              icon={<RefreshIcon size={16} />}
              label="Errors, last day"
              value={h?.detail?.api_errors !== undefined || h?.detail?.failed !== undefined ? String((h?.detail?.failed || 0) + (h?.detail?.api_errors || 0)) : "–"}
              hint={h?.detail?.questions !== undefined ? `${h.detail.failed || 0} of ${h.detail.questions} questions failed` : "From the last health check"}
            />
          </div>
        </section>

        {watch ? (
          <Progress
            deployId={watch}
            onDone={() => {
              setWatch("");
              load();
              onChanged();
            }}
          />
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <DeployCard
            client={c}
            releases={releases}
            busy={!!watch}
            rollbackTo={rollbackTo}
            onStarted={(deployId) => {
              setWatch(deployId);
              onChanged();
            }}
          />
          <HealthCard client={c} onChecked={() => load()} />
        </div>

        <History deploys={c.deploys} />
        <Checks checks={c.checks} />
        <Settings client={c} onSaved={() => { load(); onChanged(); }} onRemoved={onRemoved} />
      </div>
    </>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="mb-4 inline-flex items-center gap-1 text-sm muted hover:underline" onClick={onBack}>
      <ChevronLeftIcon size={16} />
      All clients
    </button>
  );
}

// ------------------------------------------------------------ deploy -------

function DeployCard({
  client: c,
  releases,
  busy,
  rollbackTo,
  onStarted,
}: {
  client: ClientDetail;
  releases: Release[] | null;
  busy: boolean;
  rollbackTo: string;
  onStarted: (deployId: string) => void;
}) {
  const [pick, setPick] = useState("");
  const [confirm, setConfirm] = useState<"" | "deploy" | "rollback">("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const ready = c.ready && !!c.secret_set_at;

  useEffect(() => {
    // Offer the newest release the client is not already on.
    if (!pick && releases?.length) setPick(releases.find((r) => r.version !== c.version)?.version || releases[0].version);
  }, [releases, c.version, pick]);

  async function go(kind: "deploy" | "rollback") {
    setSending(true);
    setErr("");
    try {
      const r = kind === "deploy" ? await dapi.deploy(c.id, pick) : await dapi.rollback(c.id, rollbackTo);
      setConfirm("");
      onStarted(r.deploy_id);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSending(false);
    }
  }

  const options = (releases || []).map((r) => ({
    value: r.version,
    label: r.version + (r.name && r.name !== r.version ? ` · ${r.name}` : ""),
    detail: [r.published_at ? `Published ${ago(r.published_at)}` : "", r.prerelease ? "Pre-release" : ""].filter(Boolean).join(" · "),
    note: r.version === c.version ? "Live" : undefined,
  }));

  return (
    <Card title="Deploy" sub="Ship a release to this client. If it does not come up, the version that was live is put back automatically.">
      <div className="space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <Field label="Version">
            <Select
              value={pick}
              onChange={(v) => {
                setPick(v);
                setConfirm("");
              }}
              options={options}
              loading={releases === null}
              empty="No releases published yet"
              disabled={busy || sending}
            />
          </Field>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ready || busy || sending || !pick || pick === c.version}
            title={pick === c.version ? "This version is already live" : undefined}
            onClick={() => setConfirm("deploy")}
          >
            <RocketIcon size={16} />
            Deploy
          </button>
        </div>
        {releases && releases.length === 0 ? (
          <p className="help">Publish a release first: push a tag such as v1.0.0 to GitHub. Tests run, then it appears here.</p>
        ) : null}

        {confirm ? (
          <div className="rounded-xl p-4" style={{ border: "1px solid var(--brand)", background: "var(--canvas)" }}>
            <p className="text-[15px]">
              {confirm === "deploy" ? (
                <>
                  Deploy <b>{pick}</b> to <b>{c.name}</b>
                  {c.version ? (
                    <>
                      {" "}
                      (now on <b>{c.version}</b>)
                    </>
                  ) : null}
                  ? People using the portal may see it restart for a minute.
                </>
              ) : (
                <>
                  Roll <b>{c.name}</b> back from <b>{c.version}</b> to <b>{rollbackTo}</b>?
                </>
              )}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary" disabled={sending} onClick={() => go(confirm)}>
                {sending ? "Starting…" : confirm === "deploy" ? `Deploy ${pick}` : `Roll back to ${rollbackTo}`}
              </button>
              <button type="button" className="btn btn-quiet" disabled={sending} onClick={() => setConfirm("")}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4" style={{ borderColor: "var(--line)" }}>
          <p className="min-w-0 text-[13px] faint">
            {rollbackTo ? (
              <>
                Previous good version: <Version v={rollbackTo} dim />
              </>
            ) : (
              "No earlier version to roll back to yet."
            )}
          </p>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={!ready || busy || sending || !rollbackTo}
            onClick={() => setConfirm("rollback")}
          >
            <UndoIcon size={16} />
            Roll back
          </button>
        </div>
        {busy ? <p className="help">A deploy is in progress. Deploy and roll back are available again when it finishes.</p> : null}
        {err ? <ErrorBox>{err}</ErrorBox> : null}
      </div>
    </Card>
  );
}

function Progress({ deployId, onDone }: { deployId: string; onDone: () => void }) {
  const [s, setS] = useState<Awaited<ReturnType<typeof dapi.status>> | null>(null);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(Date.now());
  const done = useRef(false);

  useEffect(() => {
    done.current = false;
    let stop = false;
    async function tick() {
      try {
        const r = await dapi.status(deployId);
        if (stop) return;
        setS(r);
        setErr("");
        if (FINAL.includes(r.current.status) && !done.current) {
          done.current = true;
          setTimeout(onDone, 1500);
          return;
        }
      } catch (e: any) {
        if (!stop) setErr(e.message);
      }
      if (!stop) setTimeout(tick, POLL_MS);
    }
    tick();
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deployId]);

  const steps = s?.steps || [];
  const cur = s?.current;
  const first = steps[0]?.at ? new Date(String(steps[0].at).replace(" ", "T") + (/[zZ]$/.test(String(steps[0].at)) ? "" : "Z")).getTime() : now;
  const secs = Math.max(0, Math.floor((now - first) / 1000));
  const runUrl = s?.run?.url || [...steps].reverse().find((x) => x.run_url)?.run_url || "";
  const ended = cur && FINAL.includes(cur.status);
  return (
    <section className="card overflow-hidden" style={{ borderColor: "var(--brand)" }} aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5" style={{ borderColor: "var(--line)" }}>
        <div className="flex min-w-0 items-center gap-3">
          {!ended ? <Spinner /> : null}
          <h2 className="truncate text-[15px] font-semibold">
            {cur ? `${verb(cur)} ${cur.version}` : "Starting"}
          </h2>
          {cur ? <DeployTag row={cur} /> : null}
        </div>
        <span className="flex items-center gap-3 text-[13px] faint">
          <span className="tabular-nums">
            {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
          </span>
          {runUrl ? (
            <a className="inline-flex items-center gap-1 underline" href={runUrl} target="_blank" rel="noreferrer">
              GitHub job
              <ArrowUpRightIcon size={13} />
            </a>
          ) : null}
        </span>
      </div>
      <ol className="px-5 py-3">
        {steps.length === 0 ? <li className="py-1.5 text-sm muted">Asking GitHub to start the job…</li> : null}
        {steps.map((st, i) => {
          const last = i === steps.length - 1;
          const bad = last && (st.status === "failed" || st.status === "rolled_back");
          return (
            <li key={i} className="flex items-start gap-3 py-1.5 text-sm">
              <span
                className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                style={
                  bad
                    ? { background: "var(--err-bg)", color: "var(--err)" }
                    : last && !ended
                      ? { background: "var(--brand-soft)", color: "var(--brand-deep)" }
                      : { background: "color-mix(in srgb, var(--ok) 14%, transparent)", color: "var(--ok)" }
                }
                aria-hidden
              >
                {bad ? <CloseIcon size={12} /> : last && !ended ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> : <CheckIcon size={12} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block">{st.step}</span>
                {st.message && (last || st.status !== "running") ? <span className="mt-0.5 block break-words text-xs faint">{st.message}</span> : null}
              </span>
              <span className="shrink-0 text-xs tabular-nums faint">{when(st.at).split(", ").pop()}</span>
            </li>
          );
        })}
      </ol>
      {err ? (
        <div className="px-5 pb-4">
          <ErrorBox>{err}</ErrorBox>
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------ health -------

function HealthCard({ client: c, onChecked }: { client: ClientDetail; onChecked: () => void }) {
  const [checking, setChecking] = useState("");
  const [err, setErr] = useState("");
  const h = c.health;

  useEffect(() => {
    if (!checking) return;
    let stop = false;
    const started = Date.now();
    async function tick() {
      try {
        const r = await dapi.checkResult(c.id, checking);
        if (stop) return;
        if (r.done) {
          setChecking("");
          if (r.error) setErr(r.error);
          onChecked();
          return;
        }
      } catch (e: any) {
        if (!stop) setErr(e.message);
      }
      if (Date.now() - started > 10 * 60 * 1000) {
        setChecking("");
        setErr("The check did not report back within 10 minutes. See the GitHub job.");
        return;
      }
      if (!stop) setTimeout(tick, POLL_MS);
    }
    tick();
    return () => {
      stop = true;
    };
  }, [checking, c.id, onChecked]);

  async function start() {
    setErr("");
    try {
      setChecking((await dapi.check(c.id)).check_id);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  const d = h?.detail;
  return (
    <Card title="Health" sub="Checked after every deploy, and whenever you ask.">
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <HealthTag status={h?.status} />
              {h ? <Version v={h.version} dim /> : null}
            </div>
            <p className="mt-2 text-[15px]">{h ? h.summary : "Not checked yet."}</p>
            {h ? <p className="mt-0.5 text-xs faint">{when(h.at)} · {h.actor ? `by ${person(h.actor)}` : "after a deploy"}</p> : null}
          </div>
          <button type="button" className="btn btn-quiet" onClick={start} disabled={!!checking || !c.ready}>
            {checking ? <Spinner /> : <RefreshIcon size={16} />}
            {checking ? "Checking…" : "Check now"}
          </button>
        </div>
        {d && (d.questions !== undefined || d.api_errors !== undefined) ? (
          <dl className="grid grid-cols-3 gap-3 rounded-xl p-3" style={{ background: "var(--canvas)", border: "1px solid var(--line)" }}>
            <Stat label="Questions" value={d.questions ?? "–"} />
            <Stat label="Failed" value={d.failed ?? "–"} />
            <Stat label="API errors" value={d.api_errors ?? "–"} />
          </dl>
        ) : null}
        {d?.errors_note ? <p className="help">{d.errors_note}</p> : null}
        {err ? <ErrorBox>{err}</ErrorBox> : null}
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs faint">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function HealthDetailView({ row }: { row: HealthRow }) {
  const d = row.detail || ({} as HealthRow["detail"]);
  return (
    <span className="block space-y-2 text-[13px]">
      {d.questions !== undefined ? (
        <span className="block muted">
          {d.questions} questions, {d.failed || 0} failed, {d.api_errors ?? 0} API errors in the day before the check.
        </span>
      ) : null}
      {d.error_kinds?.length ? (
        <span className="flex flex-wrap gap-1.5">
          {d.error_kinds.map((k) => (
            <Tag key={k.label} tone="bad">
              {k.label} · {k.count}
            </Tag>
          ))}
        </span>
      ) : null}
      {d.failing_assistants?.length ? (
        <span className="block muted">
          Failing most: {d.failing_assistants.map((a) => `${a.label} (${Math.round((a.failure_rate || 0) * 100)}% of ${a.questions})`).join(", ")}
        </span>
      ) : null}
      {d.recent_errors?.length ? <Pre>{d.recent_errors.map((e) => `${e.at}  ${e.message}`).join("\n")}</Pre> : null}
      {d.errors_note ? <span className="block faint">{d.errors_note}</span> : null}
      {d.app_state ? (
        <span className="block faint">
          Databricks: app {String(d.app_state).toLowerCase()}, compute {String(d.compute_state || "").toLowerCase()}.
        </span>
      ) : null}
      {row.run_url ? (
        <span className="block">
          <ExtLink href={row.run_url}>GitHub job</ExtLink>
        </span>
      ) : null}
    </span>
  );
}

// ------------------------------------------------------------ history ------

function History({ deploys }: { deploys: DeployRow[] }) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState("");
  const shown = deploys.filter(
    (d) => !filter || (filter === "failed" ? d.status === "failed" || d.status === "rolled_back" : d.action !== "deploy")
  );
  const pg = usePage(shown, 10, [filter]);
  return (
    <Card
      title="Deploy history"
      sub="Every deploy and rollback: who asked, what happened, and the GitHub job that did it."
      filters={
        <Chips
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            ["", "All", deploys.length],
            ["failed", "Failed", deploys.filter((d) => d.status === "failed" || d.status === "rolled_back").length],
            ["rollbacks", "Rollbacks", deploys.filter((d) => d.action !== "deploy").length],
          ]}
        />
      }
      pager={<Pager pg={pg} noun="deploys" />}
    >
      {shown.length === 0 ? (
        <Quiet>{deploys.length ? "Nothing matches." : "Nothing deployed yet."}</Quiet>
      ) : (
        <ul>
          {pg.rows.map((d) => (
            <OpenRow
              key={d.deploy_id}
              mark={d.action === "deploy" ? <RocketIcon size={14} /> : <UndoIcon size={14} />}
              title={
                <>
                  {verb(d)} <b>{d.version}</b>
                  {d.from_version && d.from_version !== d.version ? <span className="faint"> from {d.from_version}</span> : null}
                </>
              }
              meta={`${person(d.actor)} · ${when(d.started || d.at)} · ${d.step}`}
              tag={<DeployTag row={d} />}
              open={open === d.deploy_id}
              onToggle={() => setOpen(open === d.deploy_id ? "" : d.deploy_id)}
              detail={<DeployDetail row={d} />}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function DeployDetail({ row }: { row: DeployRow }) {
  const [steps, setSteps] = useState<DeployRow[] | null>(null);
  useEffect(() => {
    dapi
      .status(row.deploy_id)
      .then((s) => setSteps(s.steps))
      .catch(() => setSteps([]));
  }, [row.deploy_id]);
  const warnings = row.detail?.warnings || [];
  return (
    <span className="block space-y-2 text-[13px]">
      {row.message ? <Pre tone={row.status === "succeeded" ? "plain" : "err"}>{row.message}</Pre> : null}
      {warnings.length ? (
        <span className="block rounded-lg px-3 py-2" style={{ background: "var(--warn-bg)" }}>
          <b className="block">Warnings</b>
          {warnings.map((w, i) => (
            <span key={i} className="mt-1 block break-words">
              {w}
            </span>
          ))}
        </span>
      ) : null}
      {steps === null ? (
        <Spinner label="Loading steps…" />
      ) : steps.length ? (
        <span className="block">
          {steps.map((s, i) => (
            <span key={i} className="flex gap-3 py-0.5">
              <span className="w-12 shrink-0 tabular-nums faint">{when(s.at).split(", ").pop()}</span>
              <span className="min-w-0 break-words">{s.step}</span>
            </span>
          ))}
        </span>
      ) : null}
      {row.run_url ? (
        <span className="block">
          <ExtLink href={row.run_url}>GitHub job</ExtLink>
        </span>
      ) : null}
    </span>
  );
}

function Checks({ checks }: { checks: HealthRow[] }) {
  const [open, setOpen] = useState("");
  const pg = usePage(checks, 10);
  return (
    <Card title="Health checks" sub="The portal's own view: whether it answers, its version, and errors in the day before each check." pager={<Pager pg={pg} noun="checks" />}>
      {checks.length === 0 ? (
        <Quiet>No checks yet. Use Check now, or deploy.</Quiet>
      ) : (
        <ul>
          {pg.rows.map((h) => (
            <OpenRow
              key={h.check_id}
              mark={<PulseIcon size={14} />}
              title={h.summary || "Checked"}
              meta={`${h.version || "unknown version"} · ${when(h.at)}${h.actor ? ` · ${person(h.actor)}` : ""}`}
              tag={<HealthTag status={h.status} />}
              open={open === h.check_id}
              onToggle={() => setOpen(open === h.check_id ? "" : h.check_id)}
              detail={<HealthDetailView row={h} />}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

// ------------------------------------------------------------ settings -----

function Settings({ client: c, onSaved, onRemoved }: { client: ClientDetail; onSaved: () => void; onRemoved: () => void }) {
  const initial: ClientForm = {
    name: c.name,
    host: c.host,
    client_id: c.client_id,
    app_name: c.app_name,
    log_table: c.log_table,
    warehouse_id: c.warehouse_id,
    users_group: c.users_group,
    secret: "",
  };
  const [f, setF] = useState<ClientForm>(initial);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [removing, setRemoving] = useState(false);
  const [typed, setTyped] = useState("");
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const set = (k: keyof ClientForm) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setF({ ...f, [k]: e.target.value });
    setMsg("");
  };

  async function save() {
    setSaving(true);
    setErr("");
    setMsg("");
    try {
      const changed: ClientForm = {};
      (Object.keys(f) as (keyof ClientForm)[]).forEach((k) => {
        if (f[k] !== initial[k]) changed[k] = f[k];
      });
      await dapi.edit(c.id, changed);
      setMsg(changed.secret ? "Saved. The new secret is used from the next deploy." : "Saved.");
      setF({ ...f, secret: "" });
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    try {
      await dapi.remove(c.id);
      onRemoved();
    } catch (e: any) {
      setErr(e.message);
      setSaving(false);
    }
  }

  return (
    <Card title="Settings" sub="Kept in this client's GitHub environment. The secret is stored encrypted by GitHub and can only be replaced, never read back.">
      <div className="space-y-5 p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Client name">
            <input className="field" value={f.name} onChange={set("name")} maxLength={80} />
          </Field>
          <Field label="Workspace address">
            <input className="field" value={f.host} onChange={set("host")} placeholder="https://adb-….azuredatabricks.net" />
          </Field>
          <Field label="Service principal application id">
            <input className="field font-mono !text-[13px]" value={f.client_id} onChange={set("client_id")} />
          </Field>
          <Field label="Service principal secret" hint={c.secret_set_at ? `Last set ${ago(c.secret_set_at)}. Leave empty to keep it.` : "Not set yet."}>
            <input className="field" type="password" autoComplete="new-password" value={f.secret} onChange={set("secret")} placeholder="Paste a new secret to replace it" />
          </Field>
          <Field label="App name" hint="The Databricks app in the client's workspace.">
            <input className="field font-mono !text-[13px]" value={f.app_name} onChange={set("app_name")} />
          </Field>
          <Field label="Chat history table" hint="catalog.schema.table. Empty turns history and dashboards off.">
            <input className="field font-mono !text-[13px]" value={f.log_table} onChange={set("log_table")} placeholder="main.agent_portal.portal_logs" />
          </Field>
          <Field label="SQL warehouse id (optional)" hint="Empty picks one automatically.">
            <input className="field font-mono !text-[13px]" value={f.warehouse_id} onChange={set("warehouse_id")} />
          </Field>
          <Field label="Who can open the portal" hint="A workspace group. Empty means everyone in the workspace (users).">
            <input className="field" value={f.users_group} onChange={set("users_group")} placeholder="users" />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={save}>
            {saving ? "Saving…" : "Save changes"}
          </button>
          {dirty ? (
            <button type="button" className="btn btn-quiet" disabled={saving} onClick={() => setF(initial)}>
              Discard
            </button>
          ) : null}
          {msg ? <span className="text-sm" style={{ color: "var(--ok)" }}>{msg}</span> : null}
        </div>
        {err ? <ErrorBox>{err}</ErrorBox> : null}

        <div className="rounded-xl p-4" style={{ border: "1px solid color-mix(in srgb, var(--err) 35%, var(--line))" }}>
          <h3 className="text-[15px] font-semibold">Remove this client</h3>
          <p className="mt-1 text-[13px] muted">
            Deletes its GitHub environment and secret. The portal keeps running in their workspace and its history stays in the
            deployment record.
          </p>
          {!removing ? (
            <button type="button" className="btn btn-quiet mt-3" onClick={() => setRemoving(true)}>
              Remove client…
            </button>
          ) : (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <Field label={`Type ${c.id.replace(/^client-/, "")} to confirm`}>
                <input className="field w-60" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
              </Field>
              <button
                type="button"
                className="btn btn-primary"
                style={{ ["--btn-from" as any]: "var(--err)", ["--btn-to" as any]: "var(--err)" }}
                disabled={typed !== c.id.replace(/^client-/, "") || saving}
                onClick={remove}
              >
                Remove
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => { setRemoving(false); setTyped(""); }}>
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
