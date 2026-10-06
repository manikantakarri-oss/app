"use client";

import { useState } from "react";
import { Check, ClientForm, dapi } from "@/lib/deployer";
import { Card } from "@/components/Ops";
import { ErrorBox, Spinner } from "@/components/bits";
import { CheckIcon, ChevronLeftIcon, CloseIcon } from "@/components/icons";
import { Field, PageHead } from "./parts";

const slugOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39);

/** Add a client: their workspace, a service principal of theirs, and where
 *  history goes. "Test connection" signs in as that principal and looks around
 *  without changing anything. The secret goes straight to GitHub, encrypted. */
export function AddClient({ onBack, onAdded }: { onBack: () => void; onAdded: (id: string) => void }) {
  const [f, setF] = useState<ClientForm>({ name: "", slug: "", host: "", client_id: "", secret: "", app_name: "agent-portal", log_table: "", warehouse_id: "", users_group: "" });
  const [slugEdited, setSlugEdited] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; checks: Check[]; who: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const set = (k: keyof ClientForm) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    const next = { ...f, [k]: v };
    if (k === "name" && !slugEdited) next.slug = slugOf(v);
    if (k === "slug") setSlugEdited(true);
    if (["host", "client_id", "secret", "app_name", "log_table"].includes(k)) setTest(null);
    setF(next);
    setErr("");
  };
  const canTest = !!(f.host && f.client_id && f.secret);
  const canSave = !!(f.name && f.slug && canTest);

  async function runTest() {
    setTesting(true);
    setErr("");
    setTest(null);
    try {
      setTest(await dapi.test(f));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setErr("");
    try {
      const r = await dapi.add(f);
      onAdded(r.id);
    } catch (e: any) {
      setErr(e.message);
      setSaving(false);
    }
  }

  return (
    <>
      <button type="button" className="mb-4 inline-flex items-center gap-1 text-sm muted hover:underline" onClick={onBack}>
        <ChevronLeftIcon size={16} />
        All clients
      </button>
      <PageHead
        eyebrow="Deploy"
        title="Add a client"
        text="Connect a client's Databricks workspace. Nothing is installed until you deploy a version."
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          <Card title="Client" sub="How the client appears here.">
            <div className="grid gap-4 p-5 md:grid-cols-2">
              <Field label="Client name">
                <input className="field" value={f.name} onChange={set("name")} maxLength={80} placeholder="Acme Retail" autoFocus />
              </Field>
              <Field label="Short name" hint="Lowercase letters, digits and dashes. Cannot be changed later.">
                <input className="field font-mono !text-[13px]" value={f.slug} onChange={set("slug")} placeholder="acme-retail" maxLength={39} />
              </Field>
            </div>
          </Card>

          <Card title="Their workspace" sub="A service principal in the client's workspace that the deploy signs in as.">
            <div className="grid gap-4 p-5 md:grid-cols-2">
              <div className="md:col-span-2">
                <Field label="Workspace address" hint="The address they open Databricks with.">
                  <input className="field" value={f.host} onChange={set("host")} placeholder="https://adb-1234567890123456.7.azuredatabricks.net" />
                </Field>
              </div>
              <Field label="Service principal application id">
                <input className="field font-mono !text-[13px]" value={f.client_id} onChange={set("client_id")} placeholder="00000000-0000-0000-0000-000000000000" />
              </Field>
              <Field label="Service principal secret" hint="Sent to GitHub encrypted. Never shown again.">
                <input className="field" type="password" autoComplete="new-password" value={f.secret} onChange={set("secret")} />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t px-5 py-4" style={{ borderColor: "var(--line)" }}>
              <button type="button" className="btn btn-quiet" disabled={!canTest || testing} onClick={runTest}>
                {testing ? <Spinner /> : null}
                {testing ? "Testing…" : "Test connection"}
              </button>
              <span className="text-[13px] faint">Signs in and looks around. Changes nothing.</span>
            </div>
            {test ? (
              <ul className="border-t px-5 py-3" style={{ borderColor: "var(--line)" }} aria-live="polite">
                <li className="pb-2 text-[13px] faint">Signed in as {test.who}</li>
                {test.checks.map((c) => (
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
            ) : null}
          </Card>

          <Card title="Options" sub="Sensible defaults; change them only if the client asks.">
            <div className="grid gap-4 p-5 md:grid-cols-2">
              <Field label="Chat history table" hint="catalog.schema.table in their workspace. Empty turns history and dashboards off.">
                <input className="field font-mono !text-[13px]" value={f.log_table} onChange={set("log_table")} placeholder="main.agent_portal.portal_logs" />
              </Field>
              <Field label="Who can open the portal" hint="A workspace group. Empty means everyone (users).">
                <input className="field" value={f.users_group} onChange={set("users_group")} placeholder="users" />
              </Field>
              <Field label="App name" hint="The Databricks app to create or update.">
                <input className="field font-mono !text-[13px]" value={f.app_name} onChange={set("app_name")} />
              </Field>
              <Field label="SQL warehouse id (optional)" hint="Empty picks one automatically.">
                <input className="field font-mono !text-[13px]" value={f.warehouse_id} onChange={set("warehouse_id")} />
              </Field>
            </div>
          </Card>

          {err ? <ErrorBox>{err}</ErrorBox> : null}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn btn-primary" disabled={!canSave || saving} onClick={save}>
              {saving ? "Adding…" : "Add client"}
            </button>
            <button type="button" className="btn btn-quiet" onClick={onBack} disabled={saving}>
              Cancel
            </button>
            {test && !test.ok ? <span className="text-[13px] faint">Some checks need attention; you can still add the client and fix them later.</span> : null}
          </div>
        </div>

        <aside className="min-w-0">
          <Card title="Before you start" sub="What the client's workspace admin does once.">
            <ol className="list-decimal space-y-3 py-4 pl-10 pr-5 text-[14px] leading-6 muted">
              <li>
                In <b>Settings → Identity and access → Service principals</b>, add a service principal (for example <i>agent-portal-deployer</i>).
              </li>
              <li>
                Add it to the <b>admins</b> group, so it can create the app and set up access.
              </li>
              <li>
                Under <b>Secrets</b>, generate an OAuth secret. Share the <b>application id</b> and the <b>secret</b> with you securely.
              </li>
              <li>
                For chat history, give it <b>USE CATALOG</b> and <b>CREATE SCHEMA</b> on the catalog you name above.
              </li>
            </ol>
          </Card>
        </aside>
      </div>
    </>
  );
}
