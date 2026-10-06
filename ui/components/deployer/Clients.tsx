"use client";

import { useMemo, useState } from "react";
import { Client, Release, Setup } from "@/lib/deployer";
import { initials } from "@/lib/people";
import { contrast, hexToRgb, HEX_RE } from "@/lib/brand";
import { Card, Chips, Find, Quiet } from "@/components/Ops";
import { ErrorBox, Notice, Pager, usePage } from "@/components/bits";
import { BuildingIcon, PlusIcon, PulseIcon, RocketIcon, SparkleIcon, TagIcon } from "@/components/icons";
import { ago, compareVersions, DeployTag, HealthTag, hostLabel, latestStable, NextStep, PageHead, person, verb, Version } from "./parts";

type Filter = "" | "attention" | "updates" | "deploying" | "never";

function attention(c: Client) {
  return (
    c.health?.status === "down" ||
    c.health?.status === "degraded" ||
    c.last_deploy?.status === "failed" ||
    c.last_deploy?.status === "rolled_back" ||
    !c.ready
  );
}

/** Every client at a glance: what they run, whether it is healthy, and what
 *  happened last. The table is the page; numbers above it only count. */
export function ClientsPage({
  data,
  err,
  setup,
  releases,
  onOpen,
  onAdd,
  onSetup,
}: {
  data: { clients: Client[]; note: string } | null;
  err: string;
  setup: Setup | null;
  releases: Release[] | null;
  onOpen: (id: string) => void;
  onAdd: () => void;
  onSetup: () => void;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("");
  const all = data?.clients || [];
  const latest = latestStable(releases);
  const behind = (c: Client) => !!(latest && c.version && compareVersions(latest, c.version) > 0);
  const counts = useMemo(
    () => ({
      attention: all.filter(attention).length,
      updates: all.filter(behind).length,
      deploying: all.filter((c) => c.in_progress).length,
      never: all.filter((c) => !c.version).length,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, latest]
  );
  // "No version yet" alone gets its own, friendlier step; anything else is
  // setup to finish, counted the same as the Setup badge in the menu.
  const setupProblems = setup?.problems || 0;
  const onlyRelease = setupProblems === 1 && setup?.checks.some((c) => c.key === "release" && c.status !== "ok");

  let next = null;
  if (setupProblems && !onlyRelease) {
    next = (
      <NextStep
        tone="warn"
        icon={<SparkleIcon size={20} />}
        title={`Finish setup: ${setupProblems} thing${setupProblems > 1 ? "s" : ""} need${setupProblems > 1 ? "" : "s"} attention`}
        text="Until then, adding clients or deploying may fail. Each item says how to fix it."
        action={<button type="button" className="btn btn-primary" onClick={onSetup}>Open setup</button>}
      />
    );
  } else if (releases && releases.length === 0) {
    next = (
      <NextStep
        icon={<TagIcon size={20} />}
        title="Publish your first version"
        text="There is nothing to deploy yet. Tag a version in GitHub; it appears here once its tests pass."
        action={<button type="button" className="btn btn-primary" onClick={onSetup}>Show me how</button>}
      />
    );
  } else if (counts.attention) {
    next = (
      <NextStep
        tone="warn"
        icon={<PulseIcon size={20} />}
        title={`${counts.attention} client${counts.attention > 1 ? "s" : ""} need${counts.attention > 1 ? "" : "s"} attention`}
        text="Down, degraded, a failed deploy, or settings incomplete."
        action={<button type="button" className="btn btn-quiet" onClick={() => setFilter("attention")}>Show them</button>}
      />
    );
  } else if (counts.updates) {
    next = (
      <NextStep
        icon={<RocketIcon size={20} />}
        title={`${latest} is out: ${counts.updates} client${counts.updates > 1 ? "s" : ""} can update`}
        text="Open a client and deploy it. A failed update rolls back by itself."
        action={<button type="button" className="btn btn-quiet" onClick={() => setFilter("updates")}>Show them</button>}
      />
    );
  }
  const s = q.trim().toLowerCase();
  const shown = all.filter(
    (c) =>
      (!s || `${c.name} ${c.id} ${c.host} ${c.version}`.toLowerCase().includes(s)) &&
      (filter === "" ||
        (filter === "attention" && attention(c)) ||
        (filter === "updates" && behind(c)) ||
        (filter === "deploying" && c.in_progress) ||
        (filter === "never" && !c.version))
  );
  const pg = usePage(shown, 25, [q, filter]);

  return (
    <>
      <PageHead
        eyebrow="Deploy"
        title="Clients"
        text="Every client workspace running the Agent Portal: the version it is on, how it is doing, and what was deployed last."
        actions={
          <button type="button" className="btn btn-primary" onClick={onAdd}>
            <PlusIcon size={16} />
            Add client
          </button>
        }
      />
      {err ? <ErrorBox>{err}</ErrorBox> : null}
      {data?.note ? (
        <div className="mb-5">
          <Notice>{data.note}</Notice>
        </div>
      ) : null}

      {next}
      {data && all.length === 0 ? (
        <section className="card flex flex-col items-center gap-4 px-6 py-16 text-center">
          <span className="kpi-icon !h-12 !w-12 !rounded-2xl" aria-hidden>
            <BuildingIcon size={24} />
          </span>
          <div>
            <h2 className="text-lg font-semibold">No clients yet</h2>
            <p className="mx-auto mt-1 max-w-md text-[15px] muted">
              Add a client with their workspace address and a service principal. Then pick a version and deploy.
            </p>
          </div>
          <button type="button" className="btn btn-primary" onClick={onAdd}>
            <PlusIcon size={16} />
            Add your first client
          </button>
        </section>
      ) : (
        <div className="space-y-6">
          <Card
            filters={
              <>
                <Chips
                  label="Show"
                  value={filter}
                  onChange={(v) => setFilter(v as Filter)}
                  options={[
                    ["", "All", all.length],
                    ["attention", "Need attention", counts.attention],
                    ["updates", "Update available", counts.updates],
                    ["deploying", "Deploying", counts.deploying],
                    ["never", "Not deployed yet", counts.never],
                  ]}
                />
                <Find value={q} onChange={setQ} placeholder="Search clients" />
              </>
            }
            pager={<Pager pg={pg} noun="clients" />}
          >
            {!data ? (
              <ul aria-busy>
                {[0, 1, 2].map((i) => (
                  <li key={i} className="flex items-center gap-4 px-5 py-4" style={{ borderTop: i ? "1px solid var(--line)" : undefined }}>
                    <span className="h-10 w-10 animate-pulse rounded-xl" style={{ background: "var(--bubble)" }} />
                    <span className="h-4 flex-1 animate-pulse rounded" style={{ background: "var(--bubble)" }} />
                  </li>
                ))}
              </ul>
            ) : shown.length === 0 ? (
              <Quiet>No clients match.</Quiet>
            ) : (
              <>
              {/* Phones: one stacked card per client; the table needs room. */}
              <ul className="md:hidden">
                {pg.rows.map((c) => (
                  <li key={c.id} style={{ borderTop: "1px solid var(--line)" }}>
                    <button type="button" className="block w-full px-5 py-4 text-left transition hover:bg-[var(--canvas)]" onClick={() => onOpen(c.id)}>
                      <span className="flex min-w-0 items-center gap-3">
                        <ClientMark c={c} />
                        <span className="min-w-0">
                          <span className="block truncate font-semibold" title={c.name}>
                            {c.name}
                          </span>
                          <span className="block truncate text-xs faint">{c.host ? hostLabel(c.host) : "Workspace not set"}</span>
                        </span>
                      </span>
                      <span className="mt-2.5 flex flex-wrap items-center gap-2">
                        <Version v={c.version} />
                        <HealthTag status={c.health?.status} />
                        {behind(c) ? <span className="text-xs font-medium" style={{ color: "var(--brand-deep)" }}>{latest} available</span> : null}
                        {c.in_progress ? <DeployTag row={c.in_progress} /> : c.last_deploy && c.last_deploy.status !== "succeeded" ? <DeployTag row={c.last_deploy} /> : null}
                      </span>
                      <span className="mt-1.5 block truncate text-xs faint">
                        {c.in_progress
                          ? `${c.in_progress.version} · ${c.in_progress.step}`
                          : c.last_deploy
                            ? `${verb(c.last_deploy)} ${c.last_deploy.version} · ${ago(c.last_deploy.started || c.last_deploy.at)}`
                            : c.ready
                              ? "Never deployed"
                              : "Settings incomplete"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead>
                    <tr className="text-[12px] font-semibold uppercase tracking-[0.06em] faint">
                      <th className="px-5 py-2.5 font-semibold">Client</th>
                      <th className="px-3 py-2.5 font-semibold">Version</th>
                      <th className="px-3 py-2.5 font-semibold">Health</th>
                      <th className="px-3 py-2.5 font-semibold">Last deploy</th>
                      <th className="px-5 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {pg.rows.map((c) => (
                      <tr
                        key={c.id}
                        className="cursor-pointer transition hover:bg-[var(--canvas)]"
                        style={{ borderTop: "1px solid var(--line)" }}
                        onClick={() => onOpen(c.id)}
                      >
                        <td className="max-w-[340px] px-5 py-3.5">
                          <span className="flex min-w-0 items-center gap-3">
                            <ClientMark c={c} />
                            <span className="min-w-0">
                              <span className="block truncate font-semibold" title={c.name}>
                                {c.name}
                              </span>
                              <span className="block truncate text-xs faint" title={c.host}>
                                {c.host ? hostLabel(c.host) : "Workspace not set"}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td className="px-3 py-3.5">
                          <span className="flex flex-col items-start gap-1">
                            <Version v={c.version} />
                            {behind(c) ? <span className="text-xs font-medium" style={{ color: "var(--brand-deep)" }}>{latest} available</span> : null}
                          </span>
                        </td>
                        <td className="px-3 py-3.5">
                          <span className="flex flex-col items-start gap-1">
                            <HealthTag status={c.health?.status} />
                            {c.health ? <span className="text-xs faint">{ago(c.health.at)}</span> : null}
                          </span>
                        </td>
                        <td className="max-w-[300px] px-3 py-3.5">
                          {c.in_progress ? (
                            <span className="flex flex-col items-start gap-1">
                              <DeployTag row={c.in_progress} />
                              <span className="block max-w-full truncate text-xs faint">
                                {c.in_progress.version} · {c.in_progress.step}
                              </span>
                            </span>
                          ) : c.last_deploy ? (
                            <span className="flex flex-col items-start gap-1">
                              <DeployTag row={c.last_deploy} />
                              <span className="block max-w-full truncate text-xs faint">
                                {verb(c.last_deploy)} {c.last_deploy.version} · {person(c.last_deploy.actor)} · {ago(c.last_deploy.started || c.last_deploy.at)}
                              </span>
                            </span>
                          ) : (
                            <span className="text-xs faint">{c.ready ? "Never deployed" : "Settings incomplete"}</span>
                          )}
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <button
                            type="button"
                            className="btn btn-quiet !min-h-[32px] !px-3 !text-[13px]"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpen(c.id);
                            }}
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

/** The client's logo, or their initials on their brand colour. */
function ClientMark({ c }: { c: Client }) {
  if (c.brand_logo) {
    return (
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg" style={{ background: "#fff", border: "1px solid var(--line)" }} aria-hidden>
        <img src={c.brand_logo} alt="" className="h-full w-full object-contain p-1" />
      </span>
    );
  }
  return (
    <span
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[12px] font-semibold"
      style={HEX_RE.test(c.brand_color) ? { background: c.brand_color, color: contrast(hexToRgb(c.brand_color), [255, 255, 255]) >= 3 ? "#fff" : "#111" } : { background: "var(--bubble)", color: "var(--ink-dim)" }}
      aria-hidden
    >
      {initials(c.name)}
    </span>
  );
}
