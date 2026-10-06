"use client";

import { useState } from "react";
import { Client, Release } from "@/lib/deployer";
import { Card, Find, Quiet, Tag } from "@/components/Ops";
import { ErrorBox, Pager, usePage } from "@/components/bits";
import { TagIcon } from "@/components/icons";
import { ago, ExtLink, OpenRow, PageHead, when } from "./parts";

/** Published versions, newest first, and which clients run each one. */
export function ReleasesPage({ releases, err, clients, repo }: { releases: Release[] | null; err: string; clients: Client[]; repo: string }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState("");
  const names = new Map(clients.map((c) => [c.id, c.name]));
  const s = q.trim().toLowerCase();
  const all = releases || [];
  const shown = all.filter((r) => !s || `${r.version} ${r.name} ${r.notes}`.toLowerCase().includes(s));
  const pg = usePage(shown, 15, [q]);
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
          <Quiet>{all.length ? "No releases match." : "No releases published yet."}</Quiet>
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
                tag={r.prerelease ? <Tag tone="warn">Pre-release</Tag> : r.clients.length ? <Tag tone="ok">{r.clients.length} live</Tag> : undefined}
                open={open === r.version}
                onToggle={() => setOpen(open === r.version ? "" : r.version)}
                detail={
                  <span className="block space-y-2 text-[13px]">
                    <span className="block max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-lg px-3 py-2" style={{ background: "var(--canvas)", border: "1px solid var(--line)" }}>
                      {r.notes || "No release notes."}
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
