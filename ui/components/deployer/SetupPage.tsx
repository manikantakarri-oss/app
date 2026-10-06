"use client";

import { useState } from "react";
import { dapi, Setup } from "@/lib/deployer";
import { Card, Tag } from "@/components/Ops";
import { ErrorBox, Spinner } from "@/components/bits";
import { CheckIcon, CloseIcon, RefreshIcon } from "@/components/icons";
import { ago, CopyButton, ExtLink, PageHead } from "./parts";

const PUBLISH = "git tag v1.0.0\ngit push origin v1.0.0";

/** Everything the deployer depends on, checked read-only, in the order it
 *  is set up, each failure with its fix. This replaces finding out by error. */
export function SetupPage({ setup, err, onRefresh }: { setup: Setup | null; err: string; onRefresh: (s: Setup) => void }) {
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState("");

  async function recheck() {
    setBusy(true);
    setFail("");
    try {
      onRefresh(await dapi.setup(true));
    } catch (e: any) {
      setFail(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead
        eyebrow="Deploy"
        title="Setup"
        text="What the deployer needs before it can deploy, checked live. Nothing here changes anything."
        actions={
          <button type="button" className="btn btn-quiet" onClick={recheck} disabled={busy}>
            {busy ? <Spinner /> : <RefreshIcon size={16} />}
            {busy ? "Checking…" : "Check again"}
          </button>
        }
      />
      {err || fail ? (
        <div className="mb-5">
          <ErrorBox>{fail || err}</ErrorBox>
        </div>
      ) : null}
      <Card
        title={setup ? (setup.ready ? "Ready to deploy" : `${setup.problems} of ${setup.checks.length} need attention`) : "Checking…"}
        sub={setup ? `Checked ${ago(new Date(setup.checked_at * 1000).toISOString())}` : undefined}
      >
        {!setup ? (
          <div className="p-5">
            <Spinner label="Checking GitHub and Databricks…" />
          </div>
        ) : (
          <ol>
            {setup.checks.map((c, i) => (
              <li key={c.key} className="flex items-start gap-4 px-5 py-4" style={{ borderTop: i ? "1px solid var(--line)" : undefined }}>
                <span
                  className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold"
                  style={
                    c.status === "ok"
                      ? { background: "color-mix(in srgb, var(--ok) 14%, transparent)", color: "var(--ok)" }
                      : c.status === "blocked"
                        ? { background: "var(--bubble)", color: "var(--ink-faint)" }
                        : { background: "var(--err-bg)", color: "var(--err)" }
                  }
                  aria-label={c.status === "ok" ? "Ready" : c.status === "blocked" ? "Waiting on an earlier step" : "Needs attention"}
                >
                  {c.status === "ok" ? <CheckIcon size={14} /> : c.status === "blocked" ? i + 1 : <CloseIcon size={14} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">{c.label}</p>
                    {c.status === "fail" ? <Tag tone="bad">Needs attention</Tag> : c.status === "blocked" ? <Tag tone="muted">Waiting</Tag> : null}
                  </div>
                  <p className="mt-0.5 break-words text-[13px] muted">{c.detail}</p>
                  {c.fix && c.status !== "ok" ? (
                    <div className="mt-2 rounded-lg px-3 py-2 text-[13px]" style={{ background: "var(--canvas)", border: "1px solid var(--line)" }}>
                      <b>How to fix: </b>
                      {c.fix}
                      {c.key === "release" ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <code className="rounded-md px-2 py-1 font-mono text-[12.5px]" style={{ background: "var(--bubble)" }}>
                            git tag v1.0.0 &amp;&amp; git push origin v1.0.0
                          </code>
                          <CopyButton text={PUBLISH} label="Copy commands" />
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
      {setup ? (
        <p className="mt-4 text-[13px] faint">
          Repository: <ExtLink href={`https://github.com/${setup.repo}`}>{setup.repo}</ExtLink>. The full guide is in deployer/README.md.
        </p>
      ) : null}
    </>
  );
}
