"use client";

import { ReactNode, useState } from "react";
import { dapi, Release, TestResult } from "@/lib/deployer";
import { WizardFrame } from "@/components/BuilderParts";
import { ErrorBox, Select, Spinner } from "@/components/bits";
import { CheckIcon, CloseIcon } from "@/components/icons";
import { CopyButton, Field, hostLabel, latestStable } from "./parts";
import { Brand, BrandingEditor } from "./Branding";
import { ToolsChoice, ToolsPicker } from "./Tools";

const slugOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39);

const ASK = `Hi! To set up the Agent Portal in your Databricks workspace, we need a service principal (a login for the installer). It takes about 5 minutes:

1. Settings > Identity and access > Service principals > Add service principal > Add new. Name it: agent-portal-deployer
2. Settings > Identity and access > Groups > admins > Add members > agent-portal-deployer
3. Open agent-portal-deployer > Secrets > Generate secret. If it asks for scopes, choose all-apis, or these: apps, workspace, sql, unity-catalog, model-serving, supervisor-agents, secrets, access-management
4. For chat history, pick a catalog and run in the SQL editor:
   GRANT USE CATALOG, CREATE SCHEMA ON CATALOG <your_catalog> TO \`<application id>\`;

About your AI assistants: we share the ones this login can see with the portal automatically. For any assistant owned by someone else, its owner gives the portal app "Can manage" on it after we install (we will send you the app's id).

Then please send us, through a password manager or another secure channel (not plain email):
- your workspace URL
- the application (client) id
- the secret
- the catalog name from step 4`;

/** The same step frame as the portal's Build wizard, so both products work
 *  alike. Nothing is saved until the last step; nothing is installed until a
 *  version is deployed. */
const STEPS = [
  { key: "client", title: "Client" },
  { key: "connect", title: "Connect" },
  { key: "options", title: "Options" },
  { key: "review", title: "Review" },
];

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
  const [reached, setReached] = useState(0);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [editSlug, setEditSlug] = useState(false);
  const [brand, setBrand] = useState<Brand>({ name: "", color: "", logo: "" });
  const [host, setHost] = useState("");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [test, setTest] = useState<TestResult | null>(null);
  const [testErr, setTestErr] = useState("");
  const [testing, setTesting] = useState(false);
  const [history, setHistory] = useState(true);
  const [catalog, setCatalog] = useState("");
  const [everyone, setEveryone] = useState(true);
  const [share, setShare] = useState(true);
  const [tools, setTools] = useState<ToolsChoice>({ catalog: "", tools: null });
  const [group, setGroup] = useState("");
  const [appName, setAppName] = useState("agent-portal");
  const [warehouse, setWarehouse] = useState("");
  const latest = latestStable(releases);
  const [deployNow, setDeployNow] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const slugOk = /^[a-z0-9][a-z0-9-]{1,38}$/.test(slug);
  const catalogOk = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(catalog);
  const appOk = /^[a-z0-9][a-z0-9-]{1,29}$/.test(appName);
  const logTable = history && catalog ? `${catalog}.agent_portal.portal_logs` : "";

  // Why Next is not available yet, in words (empty = it is).
  const problems = [
    !name.trim() ? "Enter the client's name." : !slugOk ? "Fix the short name." : "",
    !test ? "Check the connection to continue." : "",
    history && !catalogOk ? "Choose a catalog for chat history, or switch history off." : !everyone && !group.trim() ? "Enter the group name." : !appOk ? "Fix the app name." : "",
    "",
  ];

  function go(i: number) {
    setStep(i);
    setReached((r) => Math.max(r, i));
  }

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
      const r = await dapi.test({ host, client_id: clientId.trim(), secret: secret.trim(), app_name: appName, log_table: logTable });
      setTest(r);
      // One catalog: nothing to choose. Otherwise a typed name stays, if real.
      // Preselect the only catalog it can use, if there is exactly one.
      const cats = r.catalogs || [];
      const ready = cats.filter((c) => r.catalog_access?.[c] === "ready");
      if (ready.length === 1) setCatalog(ready[0]);
      else if (cats.length === 1) setCatalog(cats[0]);
      else if (catalog && cats.length && !cats.includes(catalog)) setCatalog("");
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
        share_agents: share,
        mcp_catalog: tools.catalog,
        mcp_tools: tools.tools,
        brand_name: brand.name.trim(),
        brand_color: brand.color,
        brand_logo: brand.logo,
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

  return (
    <WizardFrame
      title="Add a client"
      steps={STEPS}
      step={step}
      reached={Math.max(reached, problems.slice(0, step + 1).every((p) => !p) ? step + 1 : step)}
      editing={false}
      onGo={go}
      err={err}
      problem={problems[step]}
      busy={saving}
      finishLabel={deployNow && latest ? `Add and deploy ${latest}` : "Add client"}
      finishDisabled={problems.some(Boolean)}
      onFinish={save}
      onCancel={onBack}
    >
      {step === 0 ? (
        <div className="space-y-6">
          <Intro title="Who is the client?" text="Their name, and if you like their logo and colour for their portal. You can change all of it later." />
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Client name" hint="As your team calls them.">
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
            <div className="min-w-0">
              {editSlug ? (
                <Field label="Short name" hint="Used in GitHub; cannot be changed later." error={slug && !slugOk ? "2 to 39 characters: lowercase letters, digits and dashes." : ""}>
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
              ) : name.trim() ? (
                <div className="md:pt-7">
                  <p className="text-[13px] faint">
                    Short name <code className="font-mono" style={{ color: "var(--ink-dim)" }}>{slug || "–"}</code>{" "}
                    <button type="button" className="underline" onClick={() => setEditSlug(true)}>
                      Change
                    </button>
                  </p>
                </div>
              ) : null}
            </div>
          </div>
          <div className="border-t pt-6" style={{ borderColor: "var(--line)" }}>
            <p className="font-semibold">
              Their branding <span className="text-[13px] font-normal faint">(optional)</span>
            </p>
            <p className="mt-0.5 text-[13px] muted">Their logo, portal name and colour. Without them the portal uses its own look.</p>
            <div className="mt-4">
              <BrandingEditor value={brand} onChange={setBrand} stacked />
            </div>
          </div>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="space-y-6">
          <Intro title="Connect their workspace" text="Their Databricks admin creates a login for the installer and sends you three values. Then check the connection." />
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="min-w-0 rounded-xl p-4" style={{ background: "var(--canvas)", border: "1px solid var(--line)" }}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="font-semibold">1. Ask their admin</p>
                <CopyButton text={ASK} label="Copy message" />
              </div>
              <p className="mt-1 text-[13px] muted">About 5 minutes on their side.</p>
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[13px]">
                <li>Add a service principal named agent-portal-deployer</li>
                <li>Put it in the admins group</li>
                <li>Generate a secret for it (scopes: all-apis, or the eight in the message)</li>
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
                {testing ? "Checking their workspace…" : test ? "Check again" : "Check the connection"}
              </button>
            </div>
          </div>
          {testErr ? <ErrorBox>{testErr}</ErrorBox> : null}
          {test ? <Checks result={test} /> : null}
        </div>
      ) : null}

      {step === 2 ? (
        <div className="space-y-6">
          <Intro title="Options" text="Sensible defaults. Change them only if the client asks." />
          <Choice label="Chat history and dashboards" hint="Keeps each person's conversations and powers the dashboards. Stored in the client's own workspace." on={history} onChange={setHistory}>
            {test?.catalogs?.length ? (
              <>
              <Field
                label="Catalog in their workspace"
                hint={catalog ? `Kept in ${catalog}.agent_portal, created on the first deploy.` : `${test.catalogs.length} catalogs the service principal can see.`}
              >
                <Select
                  value={catalog}
                  onChange={setCatalog}
                  placeholder="Choose a catalog"
                  options={[...test.catalogs]
                    .sort((a, b) => Number(test.catalog_access?.[b] === "ready") - Number(test.catalog_access?.[a] === "ready"))
                    .map((c) => {
                      const a = test.catalog_access?.[c];
                      return { value: c, label: c, detail: a === "ready" ? "Ready" : a === "needs_grant" ? "Their admin must allow this first" : undefined };
                    })}
                />
              </Field>
              {catalog && test.catalog_access?.[catalog] === "needs_grant" ? (
                <div className="mt-3 rounded-lg px-3 py-2.5 text-[13px]" style={{ background: "var(--warn-bg)" }}>
                  <p>
                    Their service principal may use <b>{catalog}</b> but not create in it, so chat history would not be set up. Ask their admin to run this,
                    or pick a catalog marked Ready:
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <code className="break-all rounded-md px-2 py-1 font-mono text-[12px]" style={{ background: "var(--surface)" }}>
                      {`GRANT USE CATALOG, CREATE SCHEMA ON CATALOG \`${catalog}\` TO \`${clientId.trim()}\`;`}
                    </code>
                    <CopyButton text={`GRANT USE CATALOG, CREATE SCHEMA ON CATALOG \`${catalog}\` TO \`${clientId.trim()}\`;`} label="Copy" />
                  </div>
                </div>
              ) : null}
              </>
            ) : (
              <Field
                label="Catalog in their workspace"
                hint={catalog && catalogOk ? `Kept in ${catalog}.agent_portal` : "The service principal could not list catalogs, so type one it may use."}
                error={catalog && !catalogOk ? "Letters, digits, underscores and dashes only." : ""}
              >
                <input className="field font-mono !text-[13px]" value={catalog} onChange={(e) => setCatalog(e.target.value.trim())} placeholder="Catalog name" />
              </Field>
            )}
          </Choice>
          <Choice
            label="Share their assistants with the portal"
            hint="On each deploy, every assistant the installer can see is shared with the portal, so it is not empty. People still only see the ones they may use. Assistants owned by others are shared by their owner."
            on={share}
            onChange={setShare}
          >
            {null}
          </Choice>
          <div className="rounded-xl p-4" style={{ border: "1px solid var(--line)" }}>
            <p className="font-semibold">Tools (MCPs)</p>
            <p className="mb-3 text-[13px] muted">Which ready-made tools their portal can add to assistants.</p>
            <ToolsPicker value={tools} onChange={setTools} />
          </div>
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
              <Field label="App name" hint="The Databricks app to create or update." error={!appOk ? "2 to 30 characters: lowercase letters, digits and dashes." : ""}>
                <input className="field font-mono !text-[13px]" value={appName} onChange={(e) => setAppName(e.target.value.trim().toLowerCase())} />
              </Field>
              <Field label="SQL warehouse id" hint="Empty picks one automatically.">
                <input className="field font-mono !text-[13px]" value={warehouse} onChange={(e) => setWarehouse(e.target.value)} />
              </Field>
            </div>
          </details>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="space-y-5">
          <Intro title="Check and add" text="Nothing is saved until you add the client." />
          <Summary title="Client" onEdit={() => go(0)}>
            <Row k="Name">
              {name.trim()} <span className="faint">({slug})</span>
            </Row>
            <Row k="Branding">
              {brand.logo || brand.color || brand.name ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  {brand.logo ? <img src={brand.logo} alt="" className="h-6 w-6 rounded bg-white object-contain p-0.5" style={{ border: "1px solid var(--line)" }} /> : null}
                  {brand.color ? <span className="inline-block h-4 w-4 rounded-full" style={{ background: brand.color }} aria-hidden /> : null}
                  <span>{brand.name.trim() || "Agent Portal"}</span>
                </span>
              ) : (
                <span className="faint">Default look</span>
              )}
            </Row>
          </Summary>
          <Summary title="Connection" onEdit={() => go(1)}>
            <Row k="Workspace">{hostLabel(host)}</Row>
            <Row k="Signs in as">{test?.who || clientId}</Row>
            <Row k="Check">
              {test ? (
                test.ok ? (
                  "Everything in place"
                ) : (
                  (() => {
                    const n = test.checks.filter((c) => !c.ok).length;
                    return `${n} thing${n > 1 ? "s" : ""} for the client to fix`;
                  })()
                )
              ) : (
                <span className="faint">Not checked</span>
              )}
            </Row>
          </Summary>
          <Summary title="Options" onEdit={() => go(2)}>
            <Row k="Chat history">{history ? `On, in ${catalog}.agent_portal` : "Off"}</Row>
            <Row k="Who can open it">{everyone ? "Everyone in their workspace" : `The group ${group.trim()}`}</Row>
            <Row k="Tools">
              {tools.tools === null ? "All tools" : tools.tools.length ? tools.tools.join(", ") : "None"}
              <span className="faint"> · {tools.catalog ? `catalog ${tools.catalog}` : "newest catalog"}</span>
            </Row>
            <Row k="Assistants">{share ? "Shared with the portal on each deploy" : "Shared by hand in their workspace"}</Row>
            <Row k="App">
              <span className="font-mono text-[13px]">{appName}</span>
              {warehouse.trim() ? <span className="faint"> · warehouse {warehouse.trim()}</span> : null}
            </Row>
          </Summary>
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
        </div>
      ) : null}
    </WizardFrame>
  );
}

function Intro({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-1 text-[15px] muted">{text}</p>
    </div>
  );
}

function Summary({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) {
  return (
    <section className="rounded-xl" style={{ border: "1px solid var(--line)" }}>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5" style={{ borderColor: "var(--line)" }}>
        <p className="font-semibold">{title}</p>
        <button type="button" className="text-[13px] font-medium underline" onClick={onEdit}>
          Edit
        </button>
      </div>
      <dl className="grid gap-x-6 gap-y-2.5 px-4 py-3 text-sm sm:grid-cols-[150px_minmax(0,1fr)]">{children}</dl>
    </section>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt className="faint">{k}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function Checks({ result }: { result: TestResult }) {
  const bad = result.checks.filter((c) => !c.ok).length;
  return (
    <div className="rounded-xl" style={{ border: "1px solid var(--line)" }} aria-live="polite">
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
      {bad ? (
        <p className="border-t px-4 py-2.5 text-[13px] faint" style={{ borderColor: "var(--line)" }}>
          You can continue and fix these later; the deploy reports anything still missing.
        </p>
      ) : null}
    </div>
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
      {on && children ? <div className="mt-3 max-w-xl pl-7">{children}</div> : null}
    </div>
  );
}
