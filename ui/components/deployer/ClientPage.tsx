"use client";

import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClientDetail, ClientForm, dapi, DeployRow, HealthRow, Release } from "@/lib/deployer";
import { Card, Chips, Find, Pre, Quiet, Tag } from "@/components/Ops";
import { ErrorBox, Notice, Pager, Select, Spinner, usePage } from "@/components/bits";
import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronLeftIcon,
  CloseIcon,
  PulseIcon,
  RefreshIcon,
  RocketIcon,
  SparkleIcon,
  UndoIcon,
} from "@/components/icons";
import {
  ago,
  compareVersions,
  CopyButton,
  DeployTag,
  Dialog,
  ExtLink,
  Field,
  HealthTag,
  hostLabel,
  latestStable,
  NextStep,
  OpenRow,
  person,
  ver,
  verb,
  Version,
  when,
} from "./parts";
import { Notes } from "./Notes";
import { BrandingEditor } from "./Branding";
import { ToolsPicker } from "./Tools";
import { GamConnection } from "./Connections";

const FINAL = ["succeeded", "failed", "rolled_back"];
const POLL_MS = 4000;
type Tab = "overview" | "history" | "settings";

/** One client. The header says what it runs and how it is; one banner says
 *  what to do next; tabs keep the detail out of the way until it is wanted. */
export function ClientPage({
  id,
  releases,
  notice,
  onBack,
  onChanged,
  onRemoved,
}: {
  id: string;
  releases: Release[] | null;
  notice?: string;
  onBack: () => void;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const [c, setC] = useState<ClientDetail | null>(null);
  const [err, setErr] = useState("");
  const [watch, setWatch] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [dialog, setDialog] = useState<null | { kind: "deploy" | "rollback"; version?: string }>(null);
  const [checking, setChecking] = useState("");
  const [checkErr, setCheckErr] = useState("");
  const [focus, setFocus] = useState("");

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

  // "Check now": poll until the GitHub job has written its result.
  useEffect(() => {
    if (!checking) return;
    let stop = false;
    const started = Date.now();
    async function tick() {
      try {
        const r = await dapi.checkResult(id, checking);
        if (stop) return;
        if (r.done) {
          setChecking("");
          if (r.error) setCheckErr(r.error);
          load();
          return;
        }
      } catch (e: any) {
        if (!stop) setCheckErr(e.message);
      }
      if (Date.now() - started > 10 * 60 * 1000) {
        setChecking("");
        setCheckErr("The check did not report back within 10 minutes. Open Jobs on GitHub to see why.");
        return;
      }
      if (!stop) setTimeout(tick, POLL_MS);
    }
    tick();
    return () => {
      stop = true;
    };
  }, [checking, id, load]);

  async function checkNow() {
    setCheckErr("");
    try {
      setChecking((await dapi.check(id)).check_id);
    } catch (e: any) {
      setCheckErr(e.message);
    }
  }

  const current = c?.version || "";
  const latest = latestStable(releases);
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
          <div className="h-20 w-1/2 animate-pulse rounded-xl" style={{ background: "var(--bubble)" }} />
          <div className="card h-[88px] animate-pulse" />
          <div className="card h-[260px] animate-pulse" />
        </div>
      </>
    );
  }

  const ready = c.ready && !!c.secret_set_at;
  const busy = !!watch;
  const url = c.health?.detail?.url || c.last_deploy?.detail?.url || "";
  const last = c.deploys.find((d) => d.action !== "auto_rollback") || null;
  const updateTo = latest && current && compareVersions(latest, current) > 0 ? latest : "";
  const history = c.deploys.length + c.checks.length;

  // The one next step, most urgent first.
  let next: ReactNode = null;
  if (!ready) {
    next = (
      <NextStep
        tone="warn"
        icon={<SparkleIcon size={20} />}
        title="Finish this client's settings"
        text="The workspace address, application id or secret is missing, so nothing can be deployed yet."
        action={<button type="button" className="btn btn-primary" onClick={() => setTab("settings")}>Open settings</button>}
      />
    );
  } else if (busy) {
    next = null;
  } else if (c.health?.status === "down") {
    next = (
      <NextStep
        tone="bad"
        icon={<PulseIcon size={20} />}
        title="The portal is down"
        text={`${c.health.summary} Checked ${ago(c.health.at)}.`}
        action={
          <>
            <button type="button" className="btn btn-quiet" onClick={checkNow} disabled={!!checking}>{checking ? "Checking…" : "Check again"}</button>
            {rollbackTo ? <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: "rollback" })}>Roll back to {rollbackTo}</button> : null}
          </>
        }
      />
    );
  } else if (last && (last.status === "failed" || last.status === "rolled_back")) {
    next = (
      <NextStep
        tone="warn"
        icon={<UndoIcon size={20} />}
        title={last.status === "rolled_back" ? `${last.version} did not come up, so ${last.detail?.rolled_back_to || current || "the previous version"} was put back` : `The last deploy of ${last.version} failed`}
        text={last.message || "See the history for each step."}
        action={
          <button type="button" className="btn btn-quiet" onClick={() => { setTab("history"); setFocus(last.deploy_id); }}>
            See what happened
          </button>
        }
      />
    );
  } else if (c.health?.detail?.assistants === 0) {
    const sp = c.health.detail.app_sp || "";
    next = (
      <NextStep
        tone="warn"
        icon={<SparkleIcon size={20} />}
        title="The portal is up, but no assistants are shared with it"
        text={
          <>
            People see an empty portal. In their workspace, give the portal&apos;s service principal{" "}
            {sp ? <code className="font-mono text-[12px]">{sp}</code> : "(see the app in Databricks)"} Can manage on each assistant, then check again.
          </>
        }
        action={
          <>
            {sp ? <CopyButton text={sp} label="Copy its id" /> : null}
            <button type="button" className="btn btn-quiet" onClick={checkNow} disabled={!!checking}>
              {checking ? "Checking…" : "Check again"}
            </button>
          </>
        }
      />
    );
  } else if (last && last.status === "succeeded" && (last.detail?.warnings || []).length) {
    const w = last.detail.warnings || [];
    next = (
      <NextStep
        tone="warn"
        icon={<SparkleIcon size={20} />}
        title={`${last.version} is live, with ${w.length} thing${w.length > 1 ? "s" : ""} to fix`}
        text={w[0] + (w.length > 1 ? ` (and ${w.length - 1} more)` : "")}
        action={
          <button type="button" className="btn btn-quiet" onClick={() => { setTab("history"); setFocus(last.deploy_id); }}>
            See all
          </button>
        }
      />
    );
  } else if (!current && latest) {
    next = (
      <NextStep
        icon={<RocketIcon size={20} />}
        title="Deploy the first version"
        text={`${latest} is the newest version. The first install takes 5 to 10 minutes.`}
        action={<button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: "deploy", version: latest })}>Deploy {latest}</button>}
      />
    );
  } else if (updateTo) {
    next = (
      <NextStep
        icon={<SparkleIcon size={20} />}
        title={`${updateTo} is available`}
        text={`${c.name} is on ${current}.`}
        action={<button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: "deploy", version: updateTo })}>Update to {updateTo}</button>}
      />
    );
  }

  return (
    <>
      <BackLink onBack={onBack} />
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="break-words text-[28px] font-semibold leading-tight tracking-[-0.02em]">{c.name}</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] muted">
            <ExtLink href={c.host}>{c.host ? hostLabel(c.host) : "Workspace not set"}</ExtLink>
            <span className="faint">·</span>
            <span>
              app <span className="font-mono text-[13px]">{c.app_name}</span>
            </span>
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Version v={current} />
            <HealthTag status={c.health?.status} />
            {busy ? <Tag tone="warn">Deploying</Tag> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {url ? (
            <a className="btn btn-quiet" href={url} target="_blank" rel="noreferrer">
              Open portal
              <ArrowUpRightIcon size={15} />
            </a>
          ) : null}
          {rollbackTo ? (
            <button type="button" className="btn btn-quiet" disabled={!ready || busy} onClick={() => setDialog({ kind: "rollback" })} title={`Put ${rollbackTo} back`}>
              <UndoIcon size={16} />
              Roll back
            </button>
          ) : null}
          <button type="button" className="btn btn-primary" disabled={!ready || busy || !releases?.length} onClick={() => setDialog({ kind: "deploy" })} title={busy ? "A deploy is in progress" : !releases?.length ? "No version is published yet" : undefined}>
            <RocketIcon size={16} />
            Deploy
          </button>
        </div>
      </div>

      {notice ? (
        <div className="mb-5">
          <ErrorBox>The client was added, but the deploy did not start: {notice}</ErrorBox>
        </div>
      ) : null}
      {err ? (
        <div className="mb-5">
          <ErrorBox>{err}</ErrorBox>
        </div>
      ) : null}
      {next}
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

      <div className="seg mb-5" role="tablist" aria-label="Client sections">
        {(
          [
            ["overview", "Overview"],
            ["history", `History${history ? ` · ${history}` : ""}`],
            ["settings", "Settings"],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <Overview
          c={c}
          checking={!!checking}
          checkErr={checkErr}
          onCheck={checkNow}
          onHistory={(focusId) => {
            setTab("history");
            setFocus(focusId || "");
          }}
        />
      ) : tab === "history" ? (
        <History deploys={c.deploys} checks={c.checks} focus={focus} />
      ) : (
        <Settings
          client={c}
          busy={busy}
          onSaved={() => {
            load();
            onChanged();
          }}
          latest={latest}
          onApply={async (version: string) => {
            const r = await dapi.deploy(c.id, version);
            setWatch(r.deploy_id);
            setTab("overview");
            onChanged();
          }}
          onRemoved={onRemoved}
        />
      )}

      {dialog ? (
        <DeployDialog
          client={c}
          releases={releases || []}
          kind={dialog.kind}
          initial={dialog.version}
          rollbackTo={rollbackTo}
          onClose={() => setDialog(null)}
          onStarted={(deployId) => {
            setDialog(null);
            setWatch(deployId);
            setTab("overview");
            onChanged();
          }}
        />
      ) : null}
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

// ------------------------------------------------------------ overview -----

function Overview({
  c,
  checking,
  checkErr,
  onCheck,
  onHistory,
}: {
  c: ClientDetail;
  checking: boolean;
  checkErr: string;
  onCheck: () => void;
  onHistory: (focus?: string) => void;
}) {
  const h = c.health;
  const d = h?.detail;
  const live = c.deploys.find((x) => x.status === "succeeded");
  const last = c.deploys[0];
  const recent = merged(c.deploys, c.checks).slice(0, 5);
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Stat
          label="Version"
          foot={
            <>
              {live ? `Live since ${ago(live.at)}, deployed by ${person(live.actor)}.` : c.version ? "Running in their workspace." : "Not deployed yet."}
              {live?.detail?.mcp_catalog ? (
                <span className="mt-1 block">
                  Tools: {live.detail.mcp_catalog.mcps.length} from MCP catalog {live.detail.mcp_catalog.ref}
                </span>
              ) : null}
              {last && last !== live && last.status !== "succeeded" ? (
                <span className="mt-1 flex flex-wrap items-center gap-1.5">
                  Last attempt: {verb(last)} {ver(last)} <DeployTag row={last} /> {ago(last.started || last.at)}
                </span>
              ) : null}
            </>
          }
        >
          {c.version ? <span className="font-mono">{c.version}</span> : <span className="faint">None</span>}
        </Stat>
        <Stat
          label="Health"
          foot={h ? `${h.summary} Checked ${ago(h.at)}.` : "Not checked yet."}
          action={
            <button type="button" className="btn btn-quiet !min-h-[30px] !px-2.5 !text-[12px]" onClick={onCheck} disabled={checking || !c.ready}>
              {checking ? <Spinner /> : <RefreshIcon size={14} />}
              {checking ? "Checking…" : "Check now"}
            </button>
          }
        >
          {h ? ({ healthy: "Healthy", degraded: "Degraded", down: "Down", unverified: "Running" } as Record<string, string>)[h.status] || h.status : <span className="faint">Unknown</span>}
        </Stat>
      </div>
      {checkErr ? <ErrorBox>{checkErr}</ErrorBox> : null}

      {d && (d.questions !== undefined || d.api_errors !== undefined) ? (
        <Card title="Last day of use" sub="From the portal itself, at the last health check.">
          <dl className="grid grid-cols-3 gap-4 p-5">
            <Num label="Questions" value={d.questions ?? "–"} />
            <Num label="Failed" value={d.failed ?? "–"} bad={!!d.failed} />
            <Num label="Log errors" value={d.api_errors ?? "–"} bad={!!d.api_errors} />
          </dl>
          {d.error_kinds?.length || d.failing_assistants?.length ? (
            <div className="space-y-2 border-t px-5 py-4 text-[13px]" style={{ borderColor: "var(--line)" }}>
              {d.error_kinds?.length ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="faint">Causes:</span>
                  {d.error_kinds.map((k) => (
                    <Tag key={k.label} tone="bad">
                      {k.label} · {k.count}
                    </Tag>
                  ))}
                </div>
              ) : null}
              {d.failing_assistants?.length ? (
                <p className="muted">
                  Failing most: {d.failing_assistants.map((a) => `${a.label} (${Math.round((a.failure_rate || 0) * 100)}% of ${a.questions})`).join(", ")}
                </p>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : d?.errors_note ? (
        <p className="help">{d.errors_note}</p>
      ) : null}

      <Card title="Recent activity">
        {recent.length === 0 ? (
          <Quiet>Nothing yet. Deploys and health checks will show here.</Quiet>
        ) : (
          <>
            <ul>
              {recent.map((r) => (
                <li key={r.key} style={{ borderTop: "1px solid var(--line)" }}>
                  <button type="button" className="flex w-full items-center gap-3 px-5 py-3 text-left transition hover:bg-[var(--canvas)]" onClick={() => onHistory(r.key)}>
                    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: "var(--brand-soft)", color: "var(--brand-deep)" }} aria-hidden>
                      {r.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{r.title}</span>
                      <span className="block truncate text-xs faint">{r.meta}</span>
                    </span>
                    {r.tag}
                  </button>
                </li>
              ))}
            </ul>
            <div className="border-t px-5 py-2.5" style={{ borderColor: "var(--line)" }}>
              <button type="button" className="text-[13px] font-medium underline" onClick={() => onHistory()}>
                See full history
              </button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, children, foot, action }: { label: string; children: ReactNode; foot: ReactNode; action?: ReactNode }) {
  return (
    <section className="card flex min-w-0 flex-col p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium muted">{label}</p>
        {action}
      </div>
      <div className="mt-2 text-[24px] font-semibold leading-tight tracking-[-0.02em]">{children}</div>
      <div className="mt-2 text-[13px] faint">{foot}</div>
    </section>
  );
}

function Num({ label, value, bad }: { label: string; value: ReactNode; bad?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[13px] faint">{label}</dt>
      <dd className="mt-1 text-[24px] font-semibold tabular-nums" style={bad ? { color: "var(--err)" } : undefined}>
        {value}
      </dd>
    </div>
  );
}

type Item = {
  key: string;
  at: string;
  kind: "deploy" | "rollback" | "check";
  failed: boolean;
  icon: ReactNode;
  title: ReactNode;
  meta: string;
  tag: ReactNode;
  /** Lower-case words the History search matches against. */
  text: string;
  deploy?: DeployRow;
  check?: HealthRow;
};

function merged(deploys: DeployRow[], checks: HealthRow[]): Item[] {
  const items: Item[] = [
    ...deploys.map((d) => ({
      key: d.deploy_id,
      at: d.started || d.at,
      kind: (d.action === "deploy" ? "deploy" : "rollback") as Item["kind"],
      failed: d.status === "failed" || d.status === "rolled_back",
      icon: d.action === "deploy" ? <RocketIcon size={14} /> : <UndoIcon size={14} />,
      title: (
        <>
          {verb(d)} <b>{ver(d)}</b>
          {d.from_version && d.from_version !== d.version ? <span className="faint"> from {d.from_version}</span> : null}
        </>
      ),
      meta: `${person(d.actor)} · ${when(d.started || d.at)} · ${d.step}`,
      tag: <DeployTag row={d} />,
      text: [verb(d), d.version, d.from_version, d.actor, person(d.actor), d.step, d.message, d.status.replace("_", " "), ...(d.detail?.warnings || [])].join(" ").toLowerCase(),
      deploy: d,
    })),
    ...checks.map((h) => ({
      key: h.check_id,
      at: h.at,
      kind: "check" as const,
      failed: h.status === "down" || h.status === "degraded",
      icon: <PulseIcon size={14} />,
      title: <>Health check: {h.summary || "checked"}</>,
      meta: `${h.version || "unknown version"} · ${when(h.at)}${h.actor ? ` · ${person(h.actor)}` : " · after a deploy"}`,
      tag: <HealthTag status={h.status} />,
      text: ["health check", h.version, h.summary, h.status, h.actor, person(h.actor)].join(" ").toLowerCase(),
      check: h,
    })),
  ];
  const t = (s: string) => new Date(String(s).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? "" : "Z")).getTime() || 0;
  return items.sort((a, b) => t(b.at) - t(a.at));
}

// ------------------------------------------------------------ deploy -------

function DeployDialog({
  client: c,
  releases,
  kind,
  initial,
  rollbackTo,
  onClose,
  onStarted,
}: {
  client: ClientDetail;
  releases: Release[];
  kind: "deploy" | "rollback";
  initial?: string;
  rollbackTo: string;
  onClose: () => void;
  onStarted: (deployId: string) => void;
}) {
  const sorted = [...releases].sort((a, b) => compareVersions(b.version, a.version));
  // Default to the newest version above the live one (a regular release
  // before a pre-release). Never preselect an older one: that is a rollback,
  // and it should be a deliberate pick.
  const newer = (r: Release) => !c.version || compareVersions(r.version, c.version) > 0;
  const [pick, setPick] = useState(
    initial || (kind === "rollback" ? rollbackTo : sorted.find((r) => newer(r) && !r.prerelease)?.version || sorted.find(newer)?.version || "")
  );
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const rel = releases.find((r) => r.version === pick);
  const older = c.version && pick && compareVersions(pick, c.version) < 0;
  const same = pick === c.version;

  async function go() {
    setSending(true);
    setErr("");
    try {
      const r = kind === "rollback" ? await dapi.rollback(c.id, pick) : await dapi.deploy(c.id, pick);
      onStarted(r.deploy_id);
    } catch (e: any) {
      setErr(e.message);
      setSending(false);
    }
  }

  return (
    <Dialog
      wide
      title={kind === "rollback" ? `Roll back ${c.name}` : `Deploy to ${c.name}`}
      sub={c.version ? `Now on ${c.version}` : "Not deployed yet"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={go} disabled={sending || !pick || same}>
            {sending ? <Spinner /> : kind === "rollback" ? <UndoIcon size={16} /> : <RocketIcon size={16} />}
            {sending ? "Starting…" : kind === "rollback" ? `Roll back to ${pick}` : `Deploy ${pick}`}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {kind === "deploy" ? (
          <Field label="Version">
            <Select
              value={pick}
              onChange={setPick}
              options={sorted.map((r) => ({
                value: r.version,
                label: r.version + (r.name && r.name !== r.version ? ` · ${r.name}` : ""),
                detail: [r.published_at ? `Published ${ago(r.published_at)}` : "", r.prerelease ? "Pre-release" : ""].filter(Boolean).join(" · "),
                note: r.version === c.version ? "Live" : undefined,
                disabled: r.version === c.version,
              }))}
              empty="No version is published yet"
            />
          </Field>
        ) : (
          <p className="text-[15px]">
            Puts <b>{pick}</b> back, the last version that worked for {c.name}. Use it when {c.version} misbehaves.
          </p>
        )}
        {rel?.notes ? (
          <div>
            <p className="text-[13px] font-medium muted">What is in {rel.version}</p>
            <div className="mt-1 max-h-44 overflow-y-auto rounded-lg px-3 py-2" style={{ background: "var(--canvas)", border: "1px solid var(--line)" }}>
              <Notes text={rel.notes} />
            </div>
          </div>
        ) : null}
        {kind === "deploy" && !pick ? <p className="text-[13px] muted">{c.name} is already on the newest version. To deploy an older one, pick it above.</p> : null}
        {older && kind === "deploy" ? <Notice>{pick} is older than the live {c.version}. That is a rollback; any newer fixes go away.</Notice> : null}
        {rel?.prerelease ? <Notice>{pick} is a pre-release. Prefer a regular version for clients.</Notice> : null}
        <ul className="space-y-1.5 text-[13px] muted">
          <li className="flex gap-2">
            <CheckIcon size={14} />
            The portal restarts; people may be signed out for about a minute.
          </li>
          <li className="flex gap-2">
            <CheckIcon size={14} />
            {c.version ? `If ${pick} does not come up, ${c.version} is put back automatically.` : "The first install takes 5 to 10 minutes."}
          </li>
          <li className="flex gap-2">
            <CheckIcon size={14} />
            Every step is recorded in the history, with who started it.
          </li>
        </ul>
        {err ? <ErrorBox>{err}</ErrorBox> : null}
      </div>
    </Dialog>
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
          setTimeout(onDone, 2500);
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
    <section className="card mb-6 overflow-hidden" style={{ borderColor: "var(--brand)" }} aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5" style={{ borderColor: "var(--line)" }}>
        <div className="flex min-w-0 items-center gap-3">
          {!ended ? <Spinner /> : null}
          <h2 className="truncate text-[15px] font-semibold">{cur ? `${verb(cur)} ${ver(cur)}`.trim() : "Starting"}</h2>
          {cur ? <DeployTag row={cur} /> : null}
        </div>
        <span className="flex items-center gap-3 text-[13px] faint">
          <span className="tabular-nums" title="Time so far">
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

// ------------------------------------------------------------ history ------

function History({ deploys, checks, focus }: { deploys: DeployRow[]; checks: HealthRow[]; focus: string }) {
  const [filter, setFilter] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(focus);
  const all = useMemo(() => merged(deploys, checks), [deploys, checks]);
  const needle = q.trim().toLowerCase();
  // The chips count what the search leaves, so a count always matches what a click shows.
  const found = needle ? all.filter((r) => r.text.includes(needle)) : all;
  const shown = found.filter(
    (r) =>
      !filter ||
      (filter === "deploys" && r.kind === "deploy") ||
      (filter === "rollbacks" && r.kind === "rollback") ||
      (filter === "checks" && r.kind === "check") ||
      (filter === "problems" && r.failed)
  );
  const pg = usePage(shown, 12, [filter, q]);
  useEffect(() => setOpen(focus), [focus]);
  return (
    <Card
      title="History"
      sub="Every deploy, rollback and health check: who started it, each step, and the GitHub job."
      filters={
        <>
        <Chips
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            ["", "All", found.length],
            ["deploys", "Deploys", found.filter((r) => r.kind === "deploy").length],
            ["rollbacks", "Rollbacks", found.filter((r) => r.kind === "rollback").length],
            ["checks", "Health checks", found.filter((r) => r.kind === "check").length],
            ["problems", "Problems", found.filter((r) => r.failed).length],
          ]}
        />
        <Find value={q} onChange={setQ} placeholder="Search history" />
        </>
      }
      pager={<Pager pg={pg} noun="events" />}
    >
      {shown.length === 0 ? (
        <Quiet>
          {!all.length ? (
            "Nothing yet."
          ) : (
            <>
              Nothing matches{needle ? ` “${q.trim()}”` : ""}.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setQ("");
                  setFilter("");
                }}
              >
                Show everything
              </button>
            </>
          )}
        </Quiet>
      ) : (
        <ul>
          {pg.rows.map((r) => (
            <OpenRow
              key={r.key}
              mark={r.icon}
              title={r.title}
              meta={r.meta}
              tag={r.tag}
              open={open === r.key}
              onToggle={() => setOpen(open === r.key ? "" : r.key)}
              detail={r.deploy ? <DeployDetail row={r.deploy} /> : r.check ? <CheckDetail row={r.check} /> : null}
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
          <b className="block">Worked, with {warnings.length} warning{warnings.length > 1 ? "s" : ""}</b>
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
              <span className="w-14 shrink-0 tabular-nums faint">{when(s.at).split(", ").pop()}</span>
              <span className="min-w-0 break-words">{s.step}</span>
            </span>
          ))}
        </span>
      ) : null}
      {row.run_url ? (
        <span className="block">
          <ExtLink href={row.run_url}>Open the GitHub job</ExtLink>
        </span>
      ) : null}
    </span>
  );
}

function CheckDetail({ row }: { row: HealthRow }) {
  const d = row.detail || ({} as HealthRow["detail"]);
  return (
    <span className="block space-y-2 text-[13px]">
      {d.questions !== undefined ? (
        <span className="block muted">
          {d.questions} questions, {d.failed || 0} failed, {d.api_errors ?? 0} errors in the log, in the day before the check.
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
      {d.recent_errors?.length ? <Pre>{d.recent_errors.map((e) => `${e.at}  ${e.message}`).join("\n")}</Pre> : null}
      {d.errors_note ? <span className="block faint">{d.errors_note}</span> : null}
      {d.app_state ? (
        <span className="block faint">
          Databricks: app {String(d.app_state).toLowerCase()}, compute {String(d.compute_state || "").toLowerCase()}.
        </span>
      ) : null}
      {row.run_url ? (
        <span className="block">
          <ExtLink href={row.run_url}>Open the GitHub job</ExtLink>
        </span>
      ) : null}
    </span>
  );
}

// ------------------------------------------------------------ settings -----

function Settings({
  client: c,
  busy,
  latest,
  onSaved,
  onApply,
  onRemoved,
}: {
  client: ClientDetail;
  busy: boolean;
  latest: string;
  onSaved: () => void;
  onApply: (version: string) => Promise<void>;
  onRemoved: () => void;
}) {
  // Branding is read by the portal from v1.2.0 on; an older live version
  // would be redeployed unchanged, so offer the newest version instead.
  const brandingFrom = "v1.2.0";
  const tooOld = !!c.version && compareVersions(c.version, brandingFrom) < 0;
  const applyTo = tooOld ? latest : c.version;
  const initial: ClientForm = {
    name: c.name,
    host: c.host,
    client_id: c.client_id,
    app_name: c.app_name,
    log_table: c.log_table,
    warehouse_id: c.warehouse_id,
    users_group: c.users_group,
    share_agents: c.share_agents,
    mcp_catalog: c.mcp_catalog,
    mcp_tools: c.mcp_tools,
    brand_name: c.brand_name,
    brand_color: c.brand_color,
    brand_logo: c.brand_logo,
    secret: "",
  };
  const [f, setF] = useState<ClientForm>(initial);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [removing, setRemoving] = useState(false);
  const [typed, setTyped] = useState("");
  const [dropHistory, setDropHistory] = useState(false);
  // The removal job being followed; picks up one already running (c.removing).
  const [removalId, setRemovalId] = useState(c.removing || "");
  const [removalErr, setRemovalErr] = useState("");
  const [pending, setPending] = useState(false);
  const [applying, setApplying] = useState(false);
  const slug = c.id.replace(/^client-/, "");
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
        if (JSON.stringify(f[k]) !== JSON.stringify(initial[k])) (changed as Record<string, unknown>)[k] = f[k];
      });
      await dapi.edit(c.id, changed);
      setMsg(changed.secret ? "Saved. The new secret is used from the next deploy or check." : "Saved.");
      setPending(true);
      setF({ ...f, secret: "" });
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function removeEverywhere() {
    setSaving(true);
    setRemovalErr("");
    try {
      const r = await dapi.uninstall(c.id, dropHistory);
      setRemovalId(r.deploy_id);
    } catch (e: any) {
      setRemovalErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function removalDone() {
    try {
      const s = await dapi.status(removalId);
      if (s.current.status === "succeeded") {
        onRemoved();
        return;
      }
      setRemovalErr(
        (s.current.message || "The removal did not finish.") +
          " Nothing was removed from the deployer. Fix it and try again, or use \"Only remove it here\"."
      );
    } catch (e: any) {
      setRemovalErr(e.message);
    }
    setRemovalId("");
    setTyped("");
  }

  async function removeHereOnly() {
    setSaving(true);
    try {
      await dapi.remove(c.id);
      onRemoved();
    } catch (e: any) {
      setRemovalErr(e.message);
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card title="Connection" sub="How the deployer signs in to the client's workspace.">
        <div className="grid gap-4 p-5 md:grid-cols-2">
          <Field label="Client name">
            <input className="field" value={f.name} onChange={set("name")} maxLength={80} />
          </Field>
          <Field label="Workspace address">
            <input className="field" value={f.host} onChange={set("host")} placeholder="https://adb-….azuredatabricks.net" />
          </Field>
          <Field label="Application id">
            <input className="field font-mono !text-[13px]" value={f.client_id} onChange={set("client_id")} />
          </Field>
          <Field label="Secret" hint={c.secret_set_at ? `Set ${ago(c.secret_set_at)}. Kept encrypted by GitHub; it can be replaced, never read back.` : "Not set yet."}>
            <input className="field" type="password" autoComplete="new-password" value={f.secret} onChange={set("secret")} placeholder="Paste a new secret to replace it" />
          </Field>
        </div>
      </Card>
      <Card title="Branding" sub="Their logo, name and colour in their portal. Applied when you apply or deploy.">
        <div className="p-5">
          <BrandingEditor
            value={{ name: f.brand_name || "", color: f.brand_color || "", logo: f.brand_logo || "" }}
            onChange={(b) => {
              setF({ ...f, brand_name: b.name, brand_color: b.color, brand_logo: b.logo });
              setMsg("");
            }}
          />
        </div>
      </Card>
      <Card title="Tools (MCPs)" sub="Which tools their portal offers when building assistants, from which catalog version. Applied on the next deploy.">
        <div className="p-5">
          <ToolsPicker
            value={{ catalog: f.mcp_catalog || "", tools: f.mcp_tools === undefined ? null : f.mcp_tools }}
            onChange={(t) => {
              setF({ ...f, mcp_catalog: t.catalog, mcp_tools: t.tools });
              setMsg("");
            }}
          />
        </div>
      </Card>
      <Card title="Google Ad Manager" sub="Their own Ad Manager, for the media planner tool. Applied on the next deploy.">
        <div className="p-5">
          <GamConnection clientId={c.id} network={c.gam_network} account={c.gam_account} keySetAt={c.gam_key_set_at} onSaved={onSaved} />
        </div>
      </Card>
      <Card title="Portal options" sub="Applied on the next deploy.">
        <div className="grid gap-4 p-5 md:grid-cols-2">
          <Field label="Chat history table" hint="catalog.schema.table in their workspace. Empty turns history and dashboards off.">
            <input className="field font-mono !text-[13px]" value={f.log_table} onChange={set("log_table")} placeholder="catalog.agent_portal.portal_logs" />
          </Field>
          <Field label="Who can open the portal" hint="A group in their workspace. Empty means everyone.">
            <input className="field" value={f.users_group} onChange={set("users_group")} placeholder="Everyone" />
          </Field>
          <Field label="App name" hint="The Databricks app in their workspace.">
            <input className="field font-mono !text-[13px]" value={f.app_name} onChange={set("app_name")} />
          </Field>
          <Field label="SQL warehouse id" hint="Empty picks one automatically.">
            <input className="field font-mono !text-[13px]" value={f.warehouse_id} onChange={set("warehouse_id")} />
          </Field>
          <label className="flex cursor-pointer items-start gap-3 md:col-span-2">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-[var(--brand)]"
              checked={f.share_agents !== false}
              onChange={(e) => {
                setF({ ...f, share_agents: e.target.checked });
                setMsg("");
              }}
            />
            <span className="min-w-0">
              <span className="block text-[14px] font-medium">Share their assistants with the portal on each deploy</span>
              <span className="block text-[13px] faint">Every assistant the installer can see. People still only see the ones they may use; ones owned by others are shared by their owner.</span>
            </span>
          </label>
        </div>
      </Card>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save changes"}
        </button>
        {dirty ? (
          <button type="button" className="btn btn-quiet" disabled={saving} onClick={() => setF(initial)}>
            Discard
          </button>
        ) : null}
        {msg ? (
          <span className="text-sm" style={{ color: "var(--ok)" }}>
            {msg}
          </span>
        ) : null}
      </div>
      {pending && !dirty ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl px-4 py-3" style={{ border: "1px solid var(--brand)", background: "color-mix(in srgb, var(--brand-soft) 50%, var(--surface))" }}>
          <p className="min-w-0 flex-1 text-[14px]">
            {!c.version
              ? "These apply with the first deploy."
              : tooOld && applyTo && compareVersions(applyTo, brandingFrom) >= 0
                ? `${c.version} cannot show branding (it arrived in ${brandingFrom}). Deploy ${applyTo} to apply everything, about a minute.`
                : `Apply the changes to their portal now? This redeploys ${c.version} with the new settings, about a minute.`}
          </p>
          {c.version && applyTo ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={applying || busy}
              onClick={async () => {
                setApplying(true);
                setErr("");
                try {
                  await onApply(applyTo);
                  setPending(false);
                } catch (e: any) {
                  setErr(e.message);
                } finally {
                  setApplying(false);
                }
              }}
            >
              {applying ? "Starting…" : applyTo !== c.version ? `Deploy ${applyTo}` : "Apply now"}
            </button>
          ) : null}
        </div>
      ) : null}
      {err ? <ErrorBox>{err}</ErrorBox> : null}

      <section className="rounded-2xl p-5" style={{ border: "1px solid color-mix(in srgb, var(--err) 35%, var(--line))" }}>
        <h3 className="text-[15px] font-semibold">Remove this client</h3>
        <p className="mt-1 text-[13px] muted">
          Takes the portal out of their workspace, then removes them here. If anything cannot be removed, nothing is removed here, so you can fix
          it and try again.
        </p>
        {removalId ? (
          <div className="mt-4">
            <Progress deployId={removalId} onDone={removalDone} />
          </div>
        ) : !removing ? (
          <button type="button" className="btn btn-quiet mt-3" onClick={() => setRemoving(true)}>
            Remove client…
          </button>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl p-4" style={{ background: "var(--err-bg)" }}>
                <p className="text-[13px] font-semibold" style={{ color: "var(--err)" }}>
                  Removed from their workspace
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px]">
                  <li>The portal app ({c.app_name || "agent-portal"}) and everyone&apos;s access to it</li>
                  <li>Tools the portal installed, such as the media planner</li>
                  <li>Stored tool keys, such as their Google Ad Manager key</li>
                  <li>The portal&apos;s files</li>
                  {dropHistory ? <li>Chat history and activity logs</li> : null}
                </ul>
              </div>
              <div className="rounded-xl p-4" style={{ background: "var(--bubble)" }}>
                <p className="text-[13px] font-semibold">Kept</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] muted">
                  <li>Their assistants: they belong to their workspace and work without the portal</li>
                  {!dropHistory ? <li>Chat history and activity logs{c.log_table ? ` (${c.log_table.split(".").slice(0, 2).join(".")})` : ""}</li> : null}
                  <li>The installer login (agent-portal-deployer): their admin deletes it</li>
                  <li>The deploy history here</li>
                </ul>
              </div>
            </div>
            {c.log_table ? (
              <label className="flex cursor-pointer items-start gap-3">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--brand)]" checked={dropHistory} onChange={(e) => setDropHistory(e.target.checked)} />
                <span className="min-w-0">
                  <span className="block text-[14px] font-medium">Also delete their chat history and activity logs</span>
                  <span className="block text-[13px] faint">Everyone&apos;s saved conversations are gone for good. This cannot be undone.</span>
                </span>
              </label>
            ) : null}
            <div className="flex flex-wrap items-end gap-3">
              <Field label={`Type ${slug} to confirm`}>
                <input className="field w-60" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
              </Field>
              <button
                type="button"
                className="btn btn-primary"
                style={{ ["--btn-from" as any]: "var(--err)", ["--btn-to" as any]: "var(--err)" }}
                disabled={typed !== slug || saving}
                onClick={removeEverywhere}
              >
                {saving ? "Starting…" : "Remove everywhere"}
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setRemoving(false);
                  setTyped("");
                  setDropHistory(false);
                  setRemovalErr("");
                }}
              >
                Cancel
              </button>
            </div>
            <p className="text-[13px] faint">
              Their workspace no longer exists, or no longer lets the installer in?{" "}
              <button type="button" className="underline" disabled={typed !== slug || saving} onClick={removeHereOnly}>
                Only remove it here
              </button>{" "}
              (their workspace is left as it is; type the name above first).
            </p>
          </div>
        )}
        {removalErr ? (
          <div className="mt-3">
            <ErrorBox>{removalErr}</ErrorBox>
          </div>
        ) : null}
      </section>
    </div>
  );
}
