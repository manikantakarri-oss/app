"use client";

import { useMemo, useState } from "react";
import { Client, Release } from "@/lib/deployer";
import { Card, Find, Quiet, Tag } from "@/components/Ops";
import { ErrorBox, Pager, usePage } from "@/components/bits";
import { TagIcon } from "@/components/icons";
import { Notes } from "./Notes";
import { ago, ClientMark, CopyButton, ExtLink, latestStable, OpenRow, PageHead, when } from "./parts";

type Who = { id: string; name: string; brand_logo?: string; brand_color?: string };

/** Published versions, newest first, and which clients run each one. A row
 *  stays one line whatever the number of clients: a count, the share of all
 *  clients, and a few logos. The names are in the opened row. */
export function ReleasesPage({
  releases,
  err,
  clients,
  repo,
  onOpen,
}: {
  releases: Release[] | null;
  err: string;
  clients: Client[];
  repo: string;
  onOpen: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState("");
  const byId = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
  const s = q.trim().toLowerCase();
  const all = releases || [];
  const shown = all.filter((r) => !s || `${r.version} ${r.name} ${r.notes}`.toLowerCase().includes(s));
  const pg = usePage(shown, 15, [q]);
  const latest = latestStable(releases);
  const total = clients.length;
  // A client removed from the deployer can still be on record for a version.
  // It is not counted (the count is of current clients, so never above the
  // total) and is listed apart in the opened row, by its short name.
  const split = (ids: string[]) => ({
    on: ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!),
    gone: ids.filter((id) => !byId.has(id)).map((id) => id.replace(/^client-/, "")),
  });

  return (
    <>
      <PageHead
        eyebrow="Deploy"
        title="Releases"
        text={
          <>
            Versions you can deploy. To publish one, push a tag such as <code className="font-mono text-[13px]">v1.4.0</code> to{" "}
            <ExtLink href={repo ? `https://github.com/${repo}` : ""}>{repo || "the repository"}</ExtLink>: the tests run, and it appears here when they pass.
          </>
        }
      />
      {err ? <ErrorBox>{err}</ErrorBox> : null}
      <Card filters={<Find value={q} onChange={setQ} placeholder="Search releases" />} pager={<Pager pg={pg} noun="releases" />}>
        {releases === null ? (
          <ul aria-busy>
            {[0, 1, 2].map((i) => (
              <li key={i} className="px-5 py-4" style={{ borderTop: i ? "1px solid var(--line)" : undefined }}>
                <span className="block h-4 w-1/3 animate-pulse rounded" style={{ background: "var(--bubble)" }} />
              </li>
            ))}
          </ul>
        ) : shown.length === 0 ? (
          all.length ? (
            <Quiet>No releases match.</Quiet>
          ) : (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <p className="text-[15px] font-semibold">No version published yet</p>
              <p className="max-w-md text-[13px] muted">Run these in the repository folder. The tests run on GitHub, and the version appears here when they pass.</p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <code className="rounded-md px-2.5 py-1.5 font-mono text-[12.5px]" style={{ background: "var(--bubble)" }}>
                  git tag v1.0.0 &amp;&amp; git push origin v1.0.0
                </code>
                <CopyButton text={"git tag v1.0.0\ngit push origin v1.0.0"} label="Copy" />
              </div>
            </div>
          )
        ) : (
          <ul>
            {pg.rows.map((r) => {
              const { on, gone } = split(r.clients);
              return (
                <OpenRow
                  key={r.version}
                  mark={<TagIcon size={14} />}
                  title={
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <b className="font-mono">{r.version}</b>
                      {r.name && r.name !== r.version ? <span className="min-w-0 truncate">{r.name}</span> : null}
                      {r.prerelease ? <Tag tone="warn">Pre-release</Tag> : r.version === latest ? <Tag tone="ok">Latest</Tag> : null}
                    </span>
                  }
                  meta={
                    <span className="flex flex-wrap items-center gap-x-2">
                      <span title={when(r.published_at)}>Published {ago(r.published_at)}</span>
                      <span aria-hidden>·</span>
                      <span>{on.length ? `Live for ${on.length}${total ? ` of ${total}` : ""} client${(total || on.length) === 1 ? "" : "s"}` : "No client on it yet"}</span>
                    </span>
                  }
                  tag={on.length ? <Adoption on={on} total={total} /> : undefined}
                  open={open === r.version}
                  onToggle={() => setOpen(open === r.version ? "" : r.version)}
                  detail={
                    <span className="block space-y-4 text-[13px]">
                      <span className="block max-h-72 overflow-y-auto rounded-lg px-3 py-2" style={{ background: "var(--canvas)", border: "1px solid var(--line)" }}>
                        {r.notes ? <Notes text={r.notes} /> : "No release notes."}
                      </span>
                      {on.length ? <OnRelease version={r.version} on={on} onOpen={onOpen} /> : null}
                      {gone.length ? (
                        <span className="block faint">
                          Also on record: {gone.length} client{gone.length === 1 ? "" : "s"} since removed from the deployer ({gone.slice(0, 5).join(", ")}
                          {gone.length > 5 ? ` and ${gone.length - 5} more` : ""}).
                        </span>
                      ) : null}
                      {r.url ? <ExtLink href={r.url}>Open on GitHub</ExtLink> : null}
                    </span>
                  }
                />
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}

/** Up to four client logos and "+N", then how much of the fleet runs it. */
function Adoption({ on, total }: { on: Who[]; total: number }) {
  const pct = total ? Math.round((on.length / total) * 100) : 0;
  const extra = on.length - 4;
  return (
    <span className="hidden shrink-0 items-center gap-3 sm:flex" title={`${on.length} of ${total} clients`}>
      <span className="flex items-center gap-1">
        {on.slice(0, 4).map((c) => (
          <span key={c.id} title={c.name}>
            <ClientMark c={c} size="sm" />
          </span>
        ))}
        {extra > 0 ? (
          <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-[11px] font-semibold tabular-nums" style={{ background: "var(--bubble)", color: "var(--ink-dim)" }}>
            +{extra > 99 ? "99" : extra}
          </span>
        ) : null}
      </span>
      {total ? (
        <span className="flex w-20 flex-col gap-1">
          <span className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--bubble)" }}>
            <span className="block h-full rounded-full" style={{ width: `${Math.max(4, pct)}%`, background: "var(--brand)" }} />
          </span>
          <span className="text-right text-[11px] tabular-nums faint">{pct}%</span>
        </span>
      ) : null}
    </span>
  );
}

const FEW = 24;

/** The clients on one release: chips that open the client, a search once
 *  there are more than 12, and the first 24 with "Show all". */
function OnRelease({ version, on, onOpen }: { version: string; on: Who[]; onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const s = q.trim().toLowerCase();
  const sorted = [...on].sort((a, b) => a.name.localeCompare(b.name));
  const found = s ? sorted.filter((c) => `${c.name} ${c.id}`.toLowerCase().includes(s)) : sorted;
  const list = all || s ? found : found.slice(0, FEW);
  return (
    <span className="block">
      <span className="flex flex-wrap items-center justify-between gap-3">
        <b className="text-[13px]">
          {on.length} client{on.length === 1 ? "" : "s"} on {version}
        </b>
        {on.length > 12 ? (
          <span className="w-full sm:w-60">
            <Find value={q} onChange={setQ} placeholder="Find a client" />
          </span>
        ) : null}
      </span>
      {found.length === 0 ? (
        <span className="mt-2 block faint">No client matches “{q.trim()}”.</span>
      ) : (
        <span className="mt-2 flex flex-wrap gap-2">
          {list.map((c) => (
            <button
              key={c.id}
              type="button"
              className="inline-flex max-w-[240px] items-center gap-2 rounded-lg py-1 pl-1 pr-2.5 text-[13px] transition hover:border-[var(--brand)]"
              style={{ border: "1px solid var(--line)", background: "var(--surface)" }}
              onClick={() => onOpen(c.id)}
              title={`Open ${c.name}`}
            >
              <ClientMark c={c} size="sm" />
              <span className="truncate">{c.name}</span>
            </button>
          ))}
        </span>
      )}
      {!s && found.length > FEW ? (
        <button type="button" className="mt-2 text-[13px] font-medium underline" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${found.length}`}
        </button>
      ) : null}
    </span>
  );
}
