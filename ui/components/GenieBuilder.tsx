"use client";

import { useEffect, useState } from "react";
import { api, SourceItem } from "@/lib/api";
import { Select, Spinner, useLoad } from "./bits";
import { Access, AccessStep, Finished, Section, WizardFrame } from "./BuilderParts";

const ALL_STEPS = [
  { key: "basics", title: "Name it" },
  { key: "data", title: "Choose the data" },
  { key: "guide", title: "Teach it" },
  { key: "access", title: "Who can use it" },
  { key: "review", title: "Review" },
] as const;

type StepKey = (typeof ALL_STEPS)[number]["key"];

/** Create or edit a Genie space: an assistant that answers questions from tables.
 *  Same frame and access step as the other wizard, so it feels like one tool. */
export function GenieWizard({
  id,
  onCancel,
  onFinished,
}: {
  id: string | null;
  onCancel: () => void;
  onFinished: (d: Finished) => void;
}) {
  const editing = !!id;
  // Sharing an existing Genie space happens on its own Share button in Databricks.
  const steps = editing ? ALL_STEPS.filter((x) => x.key !== "access") : ALL_STEPS;
  const keys: StepKey[] = steps.map((x) => x.key);
  const last = steps.length - 1;

  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [tables, setTables] = useState<string[]>([]);
  const [questions, setQuestions] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [access, setAccess] = useState<Access[]>([]);
  const [chat, setChat] = useState(true);
  const [loading, setLoading] = useState(!!id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!id) return;
    api
      .genieGet(id)
      .then((g) => {
        setTitle(g.title);
        setDescription(g.description);
        setWarehouse(g.warehouse_id);
        setTables(g.tables);
        setQuestions(g.sample_questions);
        setNotes(g.notes);
        setReached(last);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const cur = keys[step];
  const problem =
    cur === "basics" && !title.trim()
      ? "Give it a name to continue."
      : cur === "data" && !warehouse
        ? "Choose the warehouse that will run the questions."
        : cur === "data" && tables.length === 0
          ? "Choose at least one table."
          : "";

  function go(i: number) {
    setErr("");
    setStep(i);
    setReached((r) => Math.max(r, i));
  }
  const goTo = (k: StepKey) => go(Math.max(0, keys.indexOf(k)));

  const spec = () => ({
    title,
    description,
    warehouse_id: warehouse,
    tables,
    sample_questions: questions,
    notes,
    access,
    chat,
  });

  async function save() {
    setBusy(true);
    setErr("");
    try {
      if (id) {
        await api.genieUpdate(id, spec());
        onFinished({ kind: "saved", name: title, variant: "data" });
      } else {
        const r = await api.genieCreate(spec());
        onFinished({
          kind: "created",
          name: title,
          variant: "data",
          chat: r.chat,
          warnings: r.warnings,
          by: r.acted_as,
          access: access.length,
        });
      }
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }

  async function remove() {
    if (!id) return;
    setBusy(true);
    setErr("");
    try {
      await api.genieDelete(id);
      onFinished({ kind: "deleted", name: title, variant: "data" });
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }

  if (loading) return <Spinner label="Loading…" />;

  return (
    <WizardFrame
      title={editing ? "Change a data assistant" : "Create a data assistant"}
      steps={steps.map((x) => ({ key: x.key, title: x.title }))}
      step={step}
      reached={reached}
      editing={editing}
      onGo={go}
      err={err}
      problem={problem}
      busy={busy}
      finishLabel={editing ? "Save changes" : "Create data assistant"}
      finishDisabled={!title.trim() || !warehouse || tables.length === 0}
      onFinish={save}
      onCancel={onCancel}
      onDelete={editing ? remove : undefined}
      deleteLabel="Delete this data assistant"
    >
      {cur === "basics" ? (
        <div className="space-y-6">
          <div>
            <h3 className="text-lg font-semibold">What do you want to call it?</h3>
            <p className="mt-1 text-[15px] muted">This is the name people will see.</p>
          </div>
          <label className="block">
            <span className="label">Name</span>
            <input
              className="field mt-2"
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="For example: Sales Numbers"
              autoFocus
            />
          </label>
          <label className="block">
            <span className="label">What is it for? (one or two sentences)</span>
            <textarea
              className="field mt-2 min-h-[96px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="For example: Answers questions about orders, customers and revenue."
            />
            <span className="help">Shown to people so they know when to use it.</span>
          </label>
        </div>
      ) : null}

      {cur === "data" ? (
        <DataStep warehouse={warehouse} setWarehouse={setWarehouse} tables={tables} setTables={setTables} />
      ) : null}

      {cur === "guide" ? (
        <GuideStep questions={questions} setQuestions={setQuestions} notes={notes} setNotes={setNotes} />
      ) : null}

      {cur === "access" ? (
        <AccessStep
          access={access}
          setAccess={setAccess}
          note="They can ask it questions but not change it. Access to the data space itself is given straight away."
        />
      ) : null}

      {cur === "review" ? (
        <div className="space-y-6">
          <div>
            <h3 className="text-lg font-semibold">Check everything looks right</h3>
            <p className="mt-1 text-[15px] muted">
              Nothing is saved until you press the button at the bottom. Use “Change” to fix anything.
            </p>
          </div>

          <Section title="Name and purpose" onChange={() => goTo("basics")}>
            <p className="text-[15px] font-semibold">{title || "—"}</p>
            <p className="text-[15px] muted">{description || "No description."}</p>
          </Section>

          <Section title="Data" onChange={() => goTo("data")}>
            <p className="break-all text-[13px] faint">Warehouse: {warehouse}</p>
            <ul className="mt-1 space-y-0.5 text-[15px]">
              {tables.map((t) => (
                <li key={t} className="break-all">
                  {t}
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Example questions and notes" onChange={() => goTo("guide")}>
            {questions.length ? (
              <ul className="list-disc space-y-0.5 pl-5 text-[15px]">
                {questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            ) : (
              <p className="text-[15px] muted">No example questions.</p>
            )}
            {notes ? <p className="mt-2 whitespace-pre-wrap text-[15px] muted">{notes}</p> : null}
          </Section>

          {!editing ? (
            <Section title="Who can use it" onChange={() => goTo("access")}>
              {access.length === 0 ? (
                <p className="text-[15px] muted">Nobody yet. Share it later from its Genie page in Databricks.</p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {access.map((a) => (
                    <li key={a.kind + a.principal} className="tag !text-sm">
                      {a.kind === "group" ? "Team: " : "Person: "}
                      {a.principal}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          ) : null}

          {!editing ? (
            <label
              className="flex cursor-pointer items-start gap-3 rounded-xl p-4"
              style={{ background: "var(--canvas)", border: "1px solid var(--line)" }}
            >
              <input
                type="checkbox"
                className="mt-1 h-5 w-5"
                checked={chat}
                onChange={(e) => setChat(e.target.checked)}
              />
              <span>
                <span className="block text-[15px] font-semibold">
                  Also let people chat with it in this portal (recommended)
                </span>
                <span className="help block">
                  Without this it only exists on the Genie page in Databricks. This makes a small assistant
                  around it that appears under “Your assistants”, using the access you chose.
                </span>
              </span>
            </label>
          ) : null}

          <p className="help">
            People also need permission to read the tables you chose. This portal cannot grant that, so ask your
            data team if someone sees “no access”.
          </p>
        </div>
      ) : null}
    </WizardFrame>
  );
}

// ------------------------------------------------------------------- data ---

function DataStep({
  warehouse,
  setWarehouse,
  tables,
  setTables,
}: {
  warehouse: string;
  setWarehouse: (v: string) => void;
  tables: string[];
  setTables: (t: string[]) => void;
}) {
  const [warehouses, setWarehouses] = useState<SourceItem[] | null>(null);
  const [whNote, setWhNote] = useState("");
  const [found, setFound] = useState<SourceItem[]>([]);
  const [catalog, setCatalog] = useState("");
  const [schema, setSchema] = useState("");
  const [loadingTables, setLoadingTables] = useState(false);
  const [tNote, setTNote] = useState("");
  const [typed, setTyped] = useState("");

  useEffect(() => {
    api
      .builderSources("warehouses")
      .then((d) => {
        setWarehouses(d.items);
        setWhNote(d.note);
      })
      .catch((e) => {
        setWarehouses([]);
        setWhNote(e.message);
      });
  }, []);

  useEffect(() => {
    setSchema("");
    setFound([]);
  }, [catalog]);
  const catsL = useLoad(() => api.builderSources("catalogs"), []);
  const schsL = useLoad(catalog ? () => api.builderSources("schemas", catalog) : null, [catalog]);
  const catalogs = catsL.data?.items || [];
  const schemas = schsL.data?.items || [];

  useEffect(() => {
    setFound([]);
    setTNote("");
    if (!catalog || !schema) return;
    setLoadingTables(true);
    api
      .builderSources("table", catalog, schema)
      .then((d) => {
        setFound(d.items);
        setTNote(d.note);
      })
      .catch((e) => setTNote(e.message))
      .finally(() => setLoadingTables(false));
  }, [catalog, schema]);

  const has = (t: string) => tables.includes(t);
  const toggle = (t: string) => setTables(has(t) ? tables.filter((x) => x !== t) : [...tables, t]);
  const addTyped = () => {
    const t = typed.trim();
    if (t && !has(t)) setTables([...tables, t]);
    setTyped("");
  };

  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-lg font-semibold">Which data should it answer questions about?</h3>
        <p className="mt-1 text-[15px] muted">
          Pick the computer that will run the questions, then the tables it can look at.
        </p>
      </div>

      <label className="block">
        <span className="label">1. Which SQL warehouse should run the questions?</span>
        <Select
          className="mt-2 max-w-xl"
          value={warehouse}
          onChange={setWarehouse}
          loading={warehouses === null}
          placeholder="Choose one…"
          empty="No warehouses found"
          options={[
            ...(warehouses || []).map((w) => ({ value: w.value, label: w.label, detail: w.detail?.trim() || undefined })),
            ...(warehouse && warehouses !== null && !warehouses.some((w) => w.value === warehouse)
              ? [{ value: warehouse, label: warehouse }]
              : []),
          ]}
        />
        <span className="help">
          A warehouse is the compute that runs the data queries. If you are not sure, pick the one your team
          already uses.
        </span>
        {whNote ? <span className="help block">{whNote}</span> : null}
      </label>

      <div>
        <p className="label">2. Which tables can it use?</p>

        {tables.length ? (
          <ul className="mt-3 flex flex-wrap gap-2" aria-label="Chosen tables">
            {tables.map((t) => (
              <li key={t} className="tag !min-h-[36px] gap-2 !text-sm">
                <span className="break-all">{t}</span>
                <button
                  type="button"
                  aria-label={`Remove ${t}`}
                  className="opacity-70 hover:opacity-100"
                  onClick={() => toggle(t)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 rounded-xl p-4 text-[15px] muted" style={{ background: "var(--canvas)" }}>
            No tables chosen yet.
          </p>
        )}

        <div className="mt-4 rounded-xl p-5" style={{ border: "1px solid var(--line)", background: "var(--canvas)" }}>
          <h4 className="text-[15px] font-semibold">Find tables</h4>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-[13px] font-medium muted">Catalog (the top-level area)</span>
              <Select className="mt-1" value={catalog} onChange={setCatalog} options={catalogs} loading={catsL.loading} />
            </label>
            <label className="block">
              <span className="text-[13px] font-medium muted">Schema (the group inside it)</span>
              <Select
                className="mt-1"
                value={schema}
                onChange={setSchema}
                options={schemas}
                disabled={!catalog}
                loading={schsL.loading}
                placeholder={catalog ? "Choose…" : "Pick a catalog first"}
              />
            </label>
          </div>

          {catalog && schema ? (
            <div className="mt-4">
              {loadingTables ? (
                <Spinner label="Loading tables…" />
              ) : found.length === 0 ? (
                <p className="text-sm muted">No tables found here. {tNote}</p>
              ) : (
                <>
                  <div className="mb-2 flex flex-wrap items-center gap-3">
                    <p className="text-[13px] font-medium muted">Tick the tables to use</p>
                    <button
                      type="button"
                      className="text-[13px] underline"
                      onClick={() => setTables(Array.from(new Set([...tables, ...found.map((f) => f.value)])))}
                    >
                      Select all
                    </button>
                  </div>
                  <ul className="max-h-72 space-y-1 overflow-y-auto pr-1">
                    {found.map((f) => (
                      <li key={f.value}>
                        <label
                          className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2 hover:bg-[var(--bubble)]"
                        >
                          <input
                            type="checkbox"
                            className="mt-1 h-5 w-5"
                            checked={has(f.value)}
                            onChange={() => toggle(f.value)}
                          />
                          <span className="min-w-0">
                            <span className="block text-[15px]">{f.label}</span>
                            {f.detail ? <span className="block text-[13px] faint">{f.detail}</span> : null}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : null}

          <details className="mt-4">
            <summary className="cursor-pointer text-[13px] font-medium muted">
              Advanced: type a table name instead
            </summary>
            <div className="mt-2 flex flex-wrap gap-3">
              <input
                className="field max-w-md flex-1"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="catalog.schema.table"
              />
              <button type="button" className="btn btn-quiet" onClick={addTyped} disabled={!typed.trim()}>
                Add this
              </button>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ guide ---

function GuideStep({
  questions,
  setQuestions,
  notes,
  setNotes,
}: {
  questions: string[];
  setQuestions: (q: string[]) => void;
  notes: string;
  setNotes: (v: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const q = draft.trim();
    if (q && !questions.includes(q)) setQuestions([...questions, q]);
    setDraft("");
  };
  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-lg font-semibold">Help it understand your questions</h3>
        <p className="mt-1 text-[15px] muted">Both parts are optional, and you can come back to them later.</p>
      </div>

      <div>
        <p className="label">Example questions</p>
        <p className="help">
          The kind of thing people will ask. They show up as suggestions and teach it how your team talks about the
          data.
        </p>
        {questions.length ? (
          <ul className="mt-3 space-y-2">
            {questions.map((q) => (
              <li
                key={q}
                className="flex items-center gap-3 rounded-xl px-4 py-2.5"
                style={{ border: "1px solid var(--line)" }}
              >
                <span className="min-w-0 flex-1 text-[15px]">{q}</span>
                <button type="button" className="btn btn-quiet !min-h-[36px] !px-3" onClick={() => setQuestions(questions.filter((x) => x !== q))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-3">
          <input
            className="field max-w-2xl flex-1"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="For example: What were total sales last month?"
          />
          <button type="button" className="btn btn-primary" onClick={add} disabled={!draft.trim()}>
            Add question
          </button>
        </div>
      </div>

      <label className="block">
        <span className="label">Notes about your data</span>
        <textarea
          className="field mt-2 min-h-[160px]"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="For example: Our financial year starts in April. “Revenue” means net revenue after refunds. Ignore test orders."
        />
        <span className="help">
          Plain sentences about how to read the numbers: what words mean and what to ignore.
        </span>
      </label>
    </div>
  );
}
