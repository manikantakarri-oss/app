"use client";

import { useMemo, useState } from "react";
import { Client, dapi, Release } from "@/lib/deployer";
import { Find } from "@/components/Ops";
import { ErrorBox, Notice, Select, Spinner } from "@/components/bits";
import { CheckIcon, RocketIcon } from "@/components/icons";
import { ClientMark, Dialog, Version } from "./parts";

type Result = Awaited<ReturnType<typeof dapi.rollout>>;

/** Roll one release out to many clients: a canary first, then the rest a few
 *  at a time, stopping at the first failure (rollout.yml). Clients that cannot
 *  take part are shown with the reason rather than hidden. */
export function RolloutDialog({
  release,
  clients,
  onClose,
  onWatch,
}: {
  release: Release;
  clients: Client[];
  onClose: () => void;
  onWatch: () => void;
}) {
  const why = (c: Client) =>
    c.version === release.version ? "Already on it" : c.in_progress ? "Deploying now" : !c.ready ? "Settings incomplete" : "";
  const eligible = useMemo(() => clients.filter((c) => !why(c)), [clients]); // eslint-disable-line react-hooks/exhaustive-deps
  const [picked, setPicked] = useState<string[]>(eligible.map((c) => c.id));
  const [canary, setCanary] = useState(eligible[0]?.id || "");
  const [parallel, setParallel] = useState(5);
  const [q, setQ] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<Result | null>(null);
  const names = new Map(clients.map((c) => [c.id, c.name]));
  const s = q.trim().toLowerCase();
  const sorted = [...clients].sort((a, b) => Number(!!why(a)) - Number(!!why(b)) || a.name.localeCompare(b.name));
  const shown = s ? sorted.filter((c) => `${c.name} ${c.id} ${c.host}`.toLowerCase().includes(s)) : sorted;
  const first = picked.includes(canary) ? canary : picked[0] || "";
  const rest = picked.length - (first ? 1 : 0);

  function toggle(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  async function start() {
    setSending(true);
    setErr("");
    try {
      setDone(await dapi.rollout(release.version, picked, first, parallel));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSending(false);
    }
  }

  if (done) {
    return (
      <Dialog
        title={done.started.length ? `Rolling out ${release.version}` : "Nothing to roll out"}
        onClose={onClose}
        footer={
          <>
            <button type="button" className="btn btn-quiet" onClick={onClose}>
              Close
            </button>
            {done.started.length ? (
              <button type="button" className="btn btn-primary" onClick={onWatch}>
                Watch on Clients
              </button>
            ) : null}
          </>
        }
      >
        <div className="space-y-3 text-[14px]">
          {done.started.length ? (
            <p>
              <b>{names.get(done.canary || "") || done.canary}</b> goes first.{" "}
              {done.started.length > 1 ? `If it comes up, ${done.started.length - 1} more follow, ${parallel} at a time.` : ""} The rollout stops at the first failure,
              and a failed client is put back on its previous version automatically.
            </p>
          ) : null}
          {done.skipped.length ? (
            <div>
              <p className="font-medium">Skipped</p>
              <ul className="mt-1 space-y-1 text-[13px] muted">
                {done.skipped.map((x) => (
                  <li key={x.client}>
                    {names.get(x.client) || x.client}: {x.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      wide
      title={`Roll out ${release.version}`}
      sub="To many clients at once, safely: one first, then the rest."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={start} disabled={sending || !picked.length}>
            {sending ? <Spinner /> : <RocketIcon size={16} />}
            {sending ? "Starting…" : `Roll out to ${picked.length} client${picked.length === 1 ? "" : "s"}`}
          </button>
        </>
      }
    >
      <div className="space-y-5">
        {release.prerelease ? <Notice>{release.version} is a pre-release. Prefer a regular version for clients.</Notice> : null}
        <div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] font-medium muted">
              Clients · {picked.length} of {eligible.length} that can take it
            </p>
            <span className="flex items-center gap-3 text-[13px]">
              <button type="button" className="underline" onClick={() => setPicked(eligible.map((c) => c.id))}>
                All
              </button>
              <button type="button" className="underline" onClick={() => setPicked([])}>
                None
              </button>
            </span>
          </div>
          {clients.length > 8 ? (
            <div className="mt-2">
              <Find value={q} onChange={setQ} placeholder="Find a client" />
            </div>
          ) : null}
          <ul className="mt-2 max-h-72 overflow-y-auto rounded-xl" style={{ border: "1px solid var(--line)" }}>
            {shown.map((c, i) => {
              const blocked = why(c);
              const on = picked.includes(c.id);
              return (
                <li key={c.id} style={{ borderTop: i ? "1px solid var(--line)" : undefined }}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-disabled={!!blocked}
                    disabled={!!blocked}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-[var(--canvas)] disabled:cursor-not-allowed disabled:opacity-55"
                    onClick={() => toggle(c.id)}
                  >
                    <span
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md"
                      style={on ? { background: "var(--brand)", color: "#fff" } : { border: "1.5px solid var(--line)", background: "var(--surface)" }}
                      aria-hidden
                    >
                      {on ? <CheckIcon size={13} /> : null}
                    </span>
                    <ClientMark c={c} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-[14px]">{c.name}</span>
                    <span className="shrink-0 text-[12px] faint">{blocked || <Version v={c.version} dim />}</span>
                  </button>
                </li>
              );
            })}
            {shown.length === 0 ? <li className="px-3 py-3 text-[13px] faint">No client matches.</li> : null}
          </ul>
        </div>

        {picked.length > 1 ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-[13px] font-medium muted">Goes first (canary)</p>
              <div className="mt-1">
                <Select value={first} onChange={setCanary} options={picked.map((id) => ({ value: id, label: names.get(id) || id }))} />
              </div>
              <p className="help">Pick a client that is easy to check, ideally your own.</p>
            </div>
            <div>
              <p className="text-[13px] font-medium muted">Then, at a time</p>
              <div className="seg mt-1" role="group" aria-label="Clients at a time">
                {[1, 3, 5, 10].map((n) => (
                  <button key={n} type="button" aria-pressed={parallel === n} onClick={() => setParallel(n)}>
                    {n}
                  </button>
                ))}
              </div>
              <p className="help">Fewer is safer; more is faster.</p>
            </div>
          </div>
        ) : null}

        {picked.length ? (
          <p className="rounded-lg px-3 py-2.5 text-[13px]" style={{ background: "var(--canvas)", border: "1px solid var(--line)" }}>
            <b>{names.get(first) || first}</b> first.{" "}
            {rest ? `If it comes up, ${rest} more, ${Math.min(parallel, rest)} at a time. ` : ""}
            Stops at the first failure; a failed client is put back on its previous version automatically.
          </p>
        ) : null}
        {err ? <ErrorBox>{err}</ErrorBox> : null}
      </div>
    </Dialog>
  );
}
