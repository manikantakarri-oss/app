"use client";

import { ReactNode, useState } from "react";
import { Check, dapi, Release } from "@/lib/deployer";
import { ErrorBox, Spinner } from "@/components/bits";
import { CheckIcon, ChevronLeftIcon, CloseIcon } from "@/components/icons";
import { CopyButton, Field, hostLabel, latestStable, PageHead } from "./parts";

const slugOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39);

const ASK = `Hi! To set up the Agent Portal in your Databricks workspace, we need a service principal (a login for the installer). It takes about 5 minutes:

1. Settings > Identity and access > Service principals > Add service principal > Add new. Name it: agent-portal-deployer
2. Settings > Identity and access > Groups > admins > Add members > agent-portal-deployer
3. Open agent-portal-deployer > Secrets > Generate secret
4. For chat history, pick a catalog and run in the SQL editor:
   GRANT USE CATALOG, CREATE SCHEMA ON CATALOG <your_catalog> TO \`<application id>\`;

Then please send us, through a password manager or another secure channel (not plain email):
- your workspace URL
- the application (client) id
- the secret
- the catalog name from step 4`;

const STEPS = ["Client", "Connect", "Review"] as const;

/** Add a client in three short steps. Nothing is saved until the last one,
 *  and nothing is installed until a version is deployed. */
export function AddClient({
  releases,
  onBack,
  onAdded,
}: {
  releases: Release[] | null;
  onBack: () => void;
  onAdded: (id: string, deployError?: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [editSlug, setEditSlug] = useState(false);
  const [host, setHost] = useState("");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [test, setTest] = useState<{ ok: boolean; checks: Check[]; who: string } | null>(null);
  const [testErr, setTestErr] = useState("");
  const [testing, setTesting] = useState(false);
  const [history, setHistory] = useState(true);
  const [catalog, setCatalog] = useState("");
  const [everyone, setEveryone] = useState(true);
  const [group, setGroup] = useState("");
  const [appName, setAppName] = useState("agent-portal");
  const [warehouse, setWarehouse] = useState("");
  const latest = latestStable(releases);
  const [deployNow, setDeployNow] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const slugOk = /^[a-z0-9][a-z0-9-]{1,38}$/.test(slug);
  const catalogOk = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(catalog);
  const signedIn = !!test;
  const logTable = history && catalog ? `${catalog}.agent_portal.portal_logs` : "";

  function changeConn(set: (v: string) => void) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      set(e.target.value);
      setTest(null);
      setTestErr("");
    };
  }

  async function runTest() {
    setTesting(true);
    setTestErr("");
    setTest(null);
    try {
      setTest(await dapi.test({ host, client_id: clientId.trim(), secret: secret.trim(), app_name: appName, log_table: logTable }));
    } catch (e: any) {
      setTestErr(e.message);
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setErr("");
    try {
      const r = await dapi.add({
        slug,
        name: name.trim(),
        host,
        client_id: clientId.trim(),
        secret: secret.trim(),
        app_name: appName,
        log_table: logTable,
        warehouse_id: warehouse.trim(),
        users_group: everyone ? "" : group.trim(),
      });
      let deployError = "";
      if (deployNow && latest) {
        try {
          await dapi.deploy(r.id, latest);
        } catch (e: any) {
          deployError = e.message;
        }
      }
      onAdded(r.id, deployError);
    } catch (e: any) {
      setErr(e.message);
      setSaving(false);
    }
  }

  const canNext =
    step === 0 ? !!name.trim() && slugOk : step === 1 ? signedIn : (!history || catalogOk) && (everyone || !!group.trim());

  return (
    <>
      <button type="button" className="mb-4 inline-flex items-center gap-1 text-sm muted hover:underline" onClick={onBack}>
        <ChevronLeftIcon size={16} />
        All clients
      </button>
      <PageHead eyebrow="Deploy" title="Add a client" text="Connect a client's Databricks workspace. Nothing is installed until you deploy." />

      <section className="card mx-auto max-w-3xl overflow-hidden">
        <ol className="flex border-b" style={{ borderColor: "var(--line)" }} aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s} className="flex flex-1 items-center gap-2.5 px-5 py-3.5 text-sm" aria-current={i === step ? "step" : undefined}>
              <span
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold"
                style={
                  i < step
                    ? { background: "var(--brand)", color: "#fff" }
                    : i === step
                      ? { background: "var(--brand-soft)", color: "var(--brand-deep)", boxShadow: "inset 0 0 0 1.5px var(--brand)" }
                      : { background: "var(--bubble)", color: "var(--ink-faint)" }
                }
                aria-hidden
              >
                {i < step ? <CheckIcon size={13} /> : i + 1}
              </span>
              <span className={i === step ? "font-semibold" : "muted"}>{s}</span>
            </li>
          ))}
        </ol>

        <div className="space-y-5 p-6">
          {step === 0 ? (
            <>
              <Field label="Client name" hint="As your team calls them. You can change it later.">
                <input
                  className="field"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!slugEdited) setSlug(slugOf(e.target.value));
                  }}
                  maxLength={80}
                  placeholder="Acme Retail"
                  autoFocus
                />
              </Field>
              {name.trim() ? (
                editSlug ? (
                  <Field label="Short name" hint="Lowercase letters, digits and dashes. Used in GitHub; cannot be changed later." error={slug && !slugOk ? "2 to 39 characters: lowercase letters, digits and dashes." : ""}>
                    <input
                      className="field font-mono !text-[13px]"
                      value={slug}
                      onChange={(e) => {
                        setSlug(e.target.value.toLowerCase());
                        setSlugEdited(true);
                      }}
                      maxLength={39}
                    />
                  </Field>
                ) : (
                  <p className="text-[13px] faint">
                    Short name <code className="font-mono" style={{ color: "var(--ink-dim)" }}>{slug || "–"}</code>{" "}
                    <button type="button" className="underline" onClick={() => setEditSlug(true)}>
                      Change
                    </button>
                  </p>
                )
              ) : null}
            </>
          ) : null}

          {step === 1 ? (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="min-w-0 rounded-xl p-4" style={{ background: "var(--canvas)", border: "1px solid var(--line)" }}>
                <div className="flex items-center justify-between gap-3">
                  <p className="font-semibold">1. Ask the client&apos;s admin</p>
                  <CopyButton text={ASK} label="Copy message" />
                </div>
                <p className="mt-1 text-[13px] muted">They create a login for the installer in their workspace and send you three values. About 5 minutes.</p>
                <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[13px]">
                  <li>Add a service principal named agent-portal-deployer</li>
                  <li>Put it in the admins group</li>
                  <li>Generate a secret for it</li>
                  <li>For chat history: allow it on a catalog</li>
                </ol>
              </div>
              <div className="min-w-0 space-y-4">
                <p className="font-semibold">2. Enter what they send</p>
                <Field label="Workspace address">
                  <input className="field" value={host} onChange={changeConn(setHost)} placeholder="https://adb-1234567890123456.7.azuredatabricks.net" autoFocus />
                </Field>
                <Field label="Application id">
                  <input className="field font-mono !text-[13px]" value={clientId} onChange={changeConn(setClientId)} placeholder="00000000-0000-0000-0000-000000000000" />
                </Field>
                <Field label="Secret" hint="Sent to GitHub encrypted, never shown again.">
                  <input className="field" type="password" autoComplete="new-password" value={secret} onChange={changeConn(setSecret)} />
                </Field>
                <button type="button" className="btn btn-quiet w-full justify-center" disabled={!host || !clientId || !secret || testing} onClick={runTest}>
                  {testing ? <Spinner /> : null}
                  {testing ? "Checking their workspace…" : signedIn ? "Check again" : "Check the connection"}
                </button>
              </div>
              {testErr || test ? (
                <div className="lg:col-span-2" aria-live="polite">
                  {testErr ? <ErrorBox>{testErr}</ErrorBox> : null}
                  {test ? <Checks result={test} /> : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 2 ? (
            <>
              <dl className="grid gap-x-6 gap-y-3 rounded-xl p-4 text-sm sm:grid-cols-[160px_minmax(0,1fr)]" style={{ background: "var(--canvas)", border: "1px solid var(--line)" }}>
                <Item k="Client">
                  {name.trim()} <span className="faint">({slug})</span>
                </Item>
                <Item k="Workspace">{hostLabel(host)}</Item>
                <Item k="Signs in as">{test?.who || clientId}</Item>
              </dl>

              <Choice
                label="Chat history and dashboards"
                hint="Keeps each person's conversations and powers the dashboards. Stored in the client's own workspace."
                on={history}
                onChange={setHistory}
              >
                <Field label="Catalog" hint={catalog && catalogOk ? `Kept in ${catalog}.agent_portal` : "A catalog in their workspace that the service principal may use."} error={catalog && !catalogOk ? "Letters, digits, underscores and dashes only." : ""}>
                  <input className="field font-mono !text-[13px]" value={catalog} onChange={(e) => setCatalog(e.target.value.trim())} placeholder="main" />
                </Field>
              </Choice>

              <div>
                <p className="text-[13px] font-medium muted">Who can open the portal</p>
                <div className="seg mt-2" role="group" aria-label="Who can open the portal">
                  <button type="button" aria-pressed={everyone} onClick={() => setEveryone(true)}>
                    Everyone in their workspace
                  </button>
                  <button type="button" aria-pressed={!everyone} onClick={() => setEveryone(false)}>
                    One group
                  </button>
                </div>
                <p className="help">People still only see the assistants they are allowed to use.</p>
                {!everyone ? (
                  <div className="mt-3 max-w-sm">
                    <Field label="Group name">
                      <input className="field" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="portal-users" />
                    </Field>
                  </div>
                ) : null}
              </div>

              <details className="rounded-xl px-4 py-3" style={{ border: "1px solid var(--line)" }}>
                <summary className="cursor-pointer text-[13px] font-medium muted">Advanced</summary>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field label="App name" hint="The Databricks app to create or update.">
                    <input className="field font-mono !text-[13px]" value={appName} onChange={(e) => setAppName(e.target.value.trim().toLowerCase())} />
                  </Field>
                  <Field label="SQL warehouse id" hint="Empty picks one automatically.">
                    <input className="field font-mono !text-[13px]" value={warehouse} onChange={(e) => setWarehouse(e.target.value)} />
                  </Field>
                </div>
              </details>

              {latest ? (
                <label className="flex cursor-pointer items-start gap-3 rounded-xl p-4" style={{ border: "1px solid var(--brand)", background: "color-mix(in srgb, var(--brand-soft) 50%, var(--surface))" }}>
                  <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--brand)]" checked={deployNow} onChange={(e) => setDeployNow(e.target.checked)} />
                  <span>
                    <span className="block font-semibold">Deploy {latest} right away</span>
                    <span className="block text-[13px] muted">Takes 5 to 10 minutes the first time. You can watch it on the client&apos;s page.</span>
                  </span>
                </label>
              ) : (
                <p className="help">No version is published yet. Add the client now and deploy once a version is out.</p>
              )}
              {err ? <ErrorBox>{err}</ErrorBox> : null}
            </>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3 border-t px-6 py-4" style={{ borderColor: "var(--line)" }}>
          <button type="button" className="btn btn-quiet" onClick={step ? () => setStep(step - 1) : onBack} disabled={saving}>
            {step ? "Back" : "Cancel"}
          </button>
          <div className="flex items-center gap-3">
            {step === 1 && !signedIn ? <span className="hidden text-[13px] faint sm:inline">Check the connection to continue</span> : null}
            {step < 2 ? (
              <button type="button" className="btn btn-primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
                Continue
              </button>
            ) : (
              <button type="button" className="btn btn-primary" disabled={!canNext || saving} onClick={save}>
                {saving ? "Adding…" : deployNow && latest ? `Add and deploy ${latest}` : "Add client"}
              </button>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

function Checks({ result }: { result: { ok: boolean; checks: Check[]; who: string } }) {
  const bad = result.checks.filter((c) => !c.ok).length;
  return (
    <div className="rounded-xl" style={{ border: "1px solid var(--line)" }}>
      <p className="border-b px-4 py-2.5 text-[13px] font-semibold" style={{ borderColor: "var(--line)" }}>
        {bad ? `Connected as ${result.who}. ${bad} thing${bad > 1 ? "s" : ""} for the client to fix:` : `Connected as ${result.who}. Everything is in place.`}
      </p>
      <ul className="px-4 py-2">
        {result.checks.map((c) => (
          <li key={c.label} className="flex items-start gap-3 py-1.5 text-sm">
            <span
              className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
              style={c.ok ? { background: "color-mix(in srgb, var(--ok) 14%, transparent)", color: "var(--ok)" } : { background: "var(--warn-bg)", color: "var(--warn-line)" }}
              aria-label={c.ok ? "OK" : "Needs attention"}
            >
              {c.ok ? <CheckIcon size={12} /> : <CloseIcon size={12} />}
            </span>
            <span className="min-w-0">
              <span className="block font-medium">{c.label}</span>
              {c.detail ? <span className="block break-words text-[13px] muted">{c.detail}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {bad ? <p className="border-t px-4 py-2.5 text-[13px] faint" style={{ borderColor: "var(--line)" }}>You can continue and fix these later; the deploy reports anything still missing.</p> : null}
    </div>
  );
}

function Item({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt className="faint">{k}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function Choice({ label, hint, on, onChange, children }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <div className="rounded-xl p-4" style={{ border: "1px solid var(--line)" }}>
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--brand)]" checked={on} onChange={(e) => onChange(e.target.checked)} />
        <span className="min-w-0">
          <span className="block font-semibold">{label}</span>
          <span className="block text-[13px] muted">{hint}</span>
        </span>
      </label>
      {on ? <div className="mt-3 max-w-sm pl-7">{children}</div> : null}
    </div>
  );
}
