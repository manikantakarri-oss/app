"use client";

import { useState } from "react";
import { Client, Release } from "@/lib/deployer";
import { Card, Find, Quiet, Tag } from "@/components/Ops";
import { ErrorBox, Pager, usePage } from "@/components/bits";
import { TagIcon } from "@/components/icons";
import { Notes } from "./Notes";
import { ago, CopyButton, ExtLink, latestStable, OpenRow, PageHead, when } from "./parts";

/** Published versions, newest first, and which clients run each one. */
export function ReleasesPage({ releases, err, clients, repo }: { releases: Release[] | null; err: string; clients: Client[]; repo: string }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState("");
  const names = new Map(clients.map((c) => [c.id, c.name]));
  const s = q.trim().toLowerCase();
  const all = releases || [];
  const shown = all.filter((r) => !s || `${r.version} ${r.name} ${r.notes}`.toLowerCase().includes(s));
  const pg = usePage(shown, 15, [q]);
  const latest = latestStable(releases);
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
            {pg.rows.map((r) => (
              <OpenRow
                key={r.version}
                mark={<TagIcon size={14} />}
                title={
                  <>
                    <b className="font-mono">{r.version}</b>
                    {r.name && r.name !== r.version ? <span> · {r.name}</span> : null}
                  </>
                }
                meta={
                  <>
                    Published {ago(r.published_at)} ({when(r.published_at)})
                    {r.clients.length ? ` · live for ${r.clients.map((id) => names.get(id) || id).join(", ")}` : " · no client on it"}
                  </>
                }
                tag={r.prerelease ? <Tag tone="warn">Pre-release</Tag> : r.version === latest ? <Tag tone="ok">Latest</Tag> : undefined}
                open={open === r.version}
                onToggle={() => setOpen(open === r.version ? "" : r.version)}
                detail={
                  <span className="block space-y-2 text-[13px]">
                    <span className="block max-h-72 overflow-y-auto rounded-lg px-3 py-2" style={{ background: "var(--canvas)", border: "1px solid var(--line)" }}>
                      {r.notes ? <Notes text={r.notes} /> : "No release notes."}
                    </span>
                    {r.url ? <ExtLink href={r.url}>Open on GitHub</ExtLink> : null}
                  </span>
                }
              />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
