"use client";

import { useEffect, useState } from "react";
import { api, BuilderTool, FileSettings, SourceItem, ToolType } from "@/lib/api";
import { CardList, Empty, ErrorBox, Spinner } from "./bits";
import { middleShort } from "@/lib/people";
import { PlusIcon } from "./icons";
import { Access, AccessStep, Done, Finished, Section, VolumeField, WizardFrame } from "./BuilderParts";
import { KnowledgeWizard } from "./KnowledgeBuilder";
import { GenieWizard } from "./GenieBuilder";

type Row = Awaited<ReturnType<typeof api.builderAgents>>["agents"][number];

/** Plain-language names for the technical tool types. The exact technical name is
 *  always shown small next to what the person picked, so nothing is hidden from
 *  an admin who knows Databricks - it is just not what they have to read first. */
const ABILITY: Record<string, { title: string; blurb: string; noun: string }> = {
  uc_function: {
    title: "Run a function",
    blurb: "A saved calculation or lookup, such as “get a weather forecast”.",
    noun: "function",
  },
  genie_space: {
    title: "Answer questions from data",
    blurb: "Lets it answer questions about your tables in plain English (a Genie space).",
    noun: "data space",
  },
  knowledge_assistant: {
    title: "Ask a document expert",
    blurb: "Hands questions to another assistant that knows your documents.",
    noun: "document expert",
  },
  vector_search_index: {
    title: "Search documents",
    blurb: "Looks things up in a collection of documents that has been prepared for searching.",
    noun: "document search",
  },
  volume: {
    title: "Read files from a folder",
    blurb: "Lets it open files that are stored in a folder.",
    noun: "folder",
  },
  uc_connection: {
    title: "Use an outside tool",
    blurb: "Connects to another system through an MCP connection.",
    noun: "outside tool",
  },
  app: {
    title: "Use a connected app",
    blurb: "Uses a Databricks app that offers tools (an MCP app).",
    noun: "app",
  },
};

// Kinds whose reference is "catalog.schema.name", so the picker browses to them.
const BROWSE = new Set(["uc_function", "volume"]);

const ALL_STEPS = [
  { key: "basics", title: "Name it" },
  { key: "behave", title: "Instructions" },
  { key: "abilities", title: "Abilities" },
  { key: "files", title: "Files" },
  { key: "access", title: "Who can use it" },
  { key: "review", title: "Review" },
] as const;

type StepKey = (typeof ALL_STEPS)[number]["key"];

const FILE_MARKER = "File handling:";

const EXAMPLE_PROMPT = [
  "You are a helpful assistant for our team. Your job is to ______.",
  "",
  "How to work:",
  "- Use the tools you have been given to find the answer rather than guessing.",
  "- If you are not sure what the person means, ask one short question first.",
  "- Keep answers short and in plain language. Use a list when there are several points.",
  "- If you cannot find the answer, say so honestly.",
].join("\n");

function fileInstructions() {
  return [
    FILE_MARKER,
    '- When the user message says "Uploaded file: <path>", that path is the input file. Pass it exactly as written as the input path of the tool.',
    '- When it says "Save any generated output file to this directory: <dir>", pass that directory as the output path of the tool.',
    "- After the tool succeeds, reply with the full /Volumes/... path of the file it produced, so the user can download it.",
  ].join("\n");
}

const FILE_TYPES = [
  { ext: "xlsx", label: "Excel" },
  { ext: "csv", label: "CSV" },
  { ext: "pdf", label: "PDF" },
  { ext: "docx", label: "Word" },
  { ext: "pptx", label: "PowerPoint" },
  { ext: "txt", label: "Text" },
];

function parseTypes(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------

export function Builder({ onGoto }: { onGoto?: (tab: string) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [spaces, setSpaces] = useState<{ space_id: string; title: string; description: string }[] | null>(null);
  const [err, setErr] = useState("");
  const [spacesErr, setSpacesErr] = useState("");
  const [kas, setKas] = useState<{ ka_id: string; display_name: string; description: string; state: string }[] | null>(null);
  const [kasErr, setKasErr] = useState("");
  // What is on screen: the lists, the "what kind?" picker, or one of the wizards.
  const [view, setView] = useState<
    | { v: "home" }
    | { v: "pick" }
    | { v: "assistant"; id: string | null }
    | { v: "genie"; id: string | null }
    | { v: "docs"; id: string | null }
  >({ v: "home" });
  const [done, setDone] = useState<Finished | null>(null);

  async function load() {
    setErr("");
    setSpacesErr("");
    setKasErr("");
    try {
      setRows((await api.builderAgents()).agents);
    } catch (e: any) {
      setRows([]);
      setErr(e.message);
    }
    try {
      setSpaces((await api.genieList()).spaces);
    } catch (e: any) {
      setSpaces([]);
      setSpacesErr(e.message);
    }
    try {
      setKas((await api.knowledgeList()).assistants);
    } catch (e: any) {
      setKas([]);
      setKasErr(e.message);
    }
  }
  useEffect(() => {
    load();
  }, []);

  const finished = (d: Finished) => {
    setDone(d);
    setView({ v: "home" });
    load();
  };

  if (view.v === "assistant") {
    return <Wizard id={view.id} onCancel={() => setView({ v: "home" })} onFinished={finished} />;
  }
  if (view.v === "docs") {
    return <KnowledgeWizard id={view.id} onCancel={() => setView({ v: "home" })} onFinished={finished} />;
  }
  if (view.v === "genie") {
    return <GenieWizard id={view.id} onCancel={() => setView({ v: "home" })} onFinished={finished} />;
  }

  if (view.v === "pick") {
    return (
      <div className="w-full">
        <div className="mb-5 flex items-center gap-3">
          <button type="button" className="btn btn-quiet" onClick={() => setView({ v: "home" })}>
            ← Cancel
          </button>
          <h2 className="text-xl font-semibold">What kind of assistant do you want to create?</h2>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-4">
          <button type="button" className="choice !p-6" aria-pressed={false} onClick={() => setView({ v: "assistant", id: null })}>
            <span>
              <span className="block text-lg font-semibold">Combine tools and information</span>
              <span className="mt-1 block text-[15px] muted">
                The all-rounder. It can run functions, answer questions from data, ask a document expert, read
                files and use outside tools, and it decides which to use for each question.
              </span>
              <span className="mt-3 block text-[13px] faint">Good for: most things</span>
            </span>
          </button>
          <button type="button" className="choice !p-6" aria-pressed={false} onClick={() => setView({ v: "docs", id: null })}>
            <span>
              <span className="block text-lg font-semibold">Answer questions from your documents</span>
              <span className="mt-1 block text-[15px] muted">
                Point it at folders of PDFs, Word files and presentations. People ask questions and get answers
                taken from those documents.
              </span>
              <span className="mt-3 block text-[13px] faint">Good for: policies, manuals, contracts and reports</span>
            </span>
          </button>
          <button type="button" className="choice !p-6" aria-pressed={false} onClick={() => setView({ v: "genie", id: null })}>
            <span>
              <span className="block text-lg font-semibold">Answer questions from your data</span>
              <span className="mt-1 block text-[15px] muted">
                People ask questions about your tables in plain English and get answers back. You choose the tables
                and give it a few example questions.
              </span>
              <span className="mt-3 block text-[13px] faint">Good for: sales, finance and operations numbers</span>
            </span>
          </button>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <Done
        done={done}
        onGoto={onGoto}
        onBack={() => setDone(null)}
        onNew={() => {
          setDone(null);
          setView({ v: "pick" });
        }}
      />
    );
  }

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0 max-w-2xl">
          <p className="text-[13px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--brand-deep)" }}>
            Manage
          </p>
          <h1 className="mt-1 text-[28px] font-semibold leading-tight tracking-[-0.02em]">Build</h1>
          <p className="mt-1.5 text-[15px] muted">
            Create an assistant in a few simple steps, or change one you already have. Everything you build
            shows up in Databricks too.
          </p>
        </div>
        <button type="button" className="btn btn-primary shrink-0" onClick={() => setView({ v: "pick" })}>
          <PlusIcon size={16} />
          Create assistant
        </button>
      </div>

      <BuiltSection title="Assistants you have built" sub="Combine tools and information. Supervisor Agents in Databricks.">
        <ErrorBox>{err}</ErrorBox>
        {rows === null ? (
          <Spinner label="Loading…" />
        ) : rows.length === 0 && !err ? (
          <Empty title="You have not built any assistants yet" hint="Press “Create assistant” above. It takes a few minutes." />
        ) : (
          <CardList
            items={rows}
            noun="assistants"
            keyOf={(r) => r.agent_id}
            text={(r) => `${r.display_name} ${r.description || ""}`}
            render={(r) => (
              <EditCard title={r.display_name} description={r.description} onOpen={() => setView({ v: "assistant", id: r.agent_id })} />
            )}
          />
        )}
      </BuiltSection>

      <BuiltSection title="Document assistants you can edit" sub="Answer questions from folders of documents. Knowledge Assistants in Databricks.">
        {kasErr ? <p className="help">Could not list them ({kasErr.slice(0, 140)}).</p> : null}
        {kas === null ? (
          <Spinner label="Loading…" />
        ) : kas.length === 0 && !kasErr ? (
          <p className="text-sm muted">None yet.</p>
        ) : (
          <CardList
            items={kas}
            noun="document assistants"
            keyOf={(k) => k.ka_id}
            text={(k) => `${k.display_name || ""} ${k.description || ""}`}
            render={(k) => <EditCard title={k.display_name} description={k.description} onOpen={() => setView({ v: "docs", id: k.ka_id })} />}
          />
        )}
      </BuiltSection>

      <BuiltSection title="Data assistants you can edit" sub="Answer questions from tables. Genie spaces in Databricks.">
        {spacesErr ? <p className="help">Could not list them ({spacesErr.slice(0, 140)}).</p> : null}
        {spaces === null ? (
          <Spinner label="Loading…" />
        ) : spaces.length === 0 && !spacesErr ? (
          <p className="text-sm muted">None yet.</p>
        ) : (
          <CardList
            items={spaces}
            noun="data assistants"
            keyOf={(sp) => sp.space_id}
            text={(sp) => `${sp.title || ""} ${sp.description || ""}`}
            render={(sp) => <EditCard title={sp.title} description={sp.description} onOpen={() => setView({ v: "genie", id: sp.space_id })} />}
          />
        )}
      </BuiltSection>
    </div>
  );
}

function BuiltSection({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="mt-10 first-of-type:mt-0">
      <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
      <p className="mb-4 mt-0.5 text-sm muted">{sub}</p>
      {children}
    </section>
  );
}

/** One editable assistant. Long one-word names are shortened in the middle so
 *  look-alike auto-created names stay distinguishable; the full name is in the tooltip. */
function EditCard({ title, description, onOpen }: { title: string; description: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={title || "Untitled"}
      className="card flex w-full flex-col p-5 text-left transition hover:border-[var(--brand)]"
    >
      <h4 className="line-clamp-2 text-base font-semibold leading-snug">{middleShort(title) || "Untitled"}</h4>
      <p className="mt-1.5 line-clamp-3 text-sm muted">{description || "No description yet"}</p>
      <p className="mt-auto pt-4 text-sm font-medium" style={{ color: "var(--brand-deep)" }}>
        Change settings →
      </p>
    </button>
  );
}

// ---------------------------------------------------------------------------

function Wizard({
  id,
  onCancel,
  onFinished,
}: {
  id: string | null;
  onCancel: () => void;
  onFinished: (d: Finished) => void;
}) {
  const editing = !!id;
  // Access is only chosen when creating. For an existing assistant it lives on
  // People & access, where the current list can be seen and changed.
  const steps = editing ? ALL_STEPS.filter((x) => x.key !== "access") : ALL_STEPS;
  const keys: StepKey[] = steps.map((x) => x.key);
  const last = steps.length - 1;

  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [tools, setTools] = useState<BuilderTool[]>([]);
  const [files, setFiles] = useState<FileSettings>({ upload_volume: "", output_volume: "", accepts: "" });
  const [wantUpload, setWantUpload] = useState(false);
  const [wantOutput, setWantOutput] = useState(false);
  const [teach, setTeach] = useState(true);
  const [access, setAccess] = useState<Access[]>([]);
  const [loading, setLoading] = useState(!!id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    if (!id) return;
    api
      .builderGet(id)
      .then((a) => {
        setName(a.display_name);
        setDescription(a.description);
        setInstructions(a.instructions);
        setTools(a.tools);
        setFiles(a.files);
        setWantUpload(!!a.files.upload_volume);
        setWantOutput(!!a.files.output_volume);
        // An agent that already carries the file block should not get it twice.
        setTeach(!a.instructions.includes(FILE_MARKER));
        setReached(last);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const cur = keys[step];
  const editable = tools.filter((t) => !t.readonly);
  const usesFiles = !!(files.upload_volume || files.output_volume);
  const finalInstructions =
    usesFiles && teach && !instructions.includes(FILE_MARKER)
      ? instructions.trim()
        ? instructions.trimEnd() + "\n\n" + fileInstructions()
        : fileInstructions()
      : instructions;

  const problem =
    cur === "basics" && !name.trim()
      ? "Give your assistant a name to continue."
      : cur === "files" && wantUpload && !files.upload_volume
        ? "Choose the folder where uploaded files should go, or switch uploads off."
        : cur === "files" && wantOutput && !files.output_volume
          ? "Choose the folder where results should be saved, or switch results off."
          : "";

  function go(i: number) {
    setErr("");
    setStep(i);
    setReached((r) => Math.max(r, i));
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }
  const goTo = (k: StepKey) => go(Math.max(0, keys.indexOf(k)));

  async function save() {
    setBusy(true);
    setErr("");
    const spec = {
      display_name: name,
      description,
      instructions: finalInstructions,
      tools: editable.map((t) => ({ type: t.type, ref: t.ref, description: t.description })),
      files,
      access,
    };
    try {
      if (id) {
        const r = await api.builderUpdate(id, spec);
        onFinished({ kind: "saved", name, warnings: r.warnings });
      } else {
        const r = await api.builderCreate(spec);
        onFinished({ kind: "created", name, warnings: r.warnings, by: r.acted_as, access: r.access_pending });
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
      await api.builderDelete(id);
      onFinished({ kind: "deleted", name });
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }

  if (loading) return <Spinner label="Loading…" />;

  return (
    <WizardFrame
      title={editing ? "Change an assistant" : "Create an assistant"}
      steps={steps.map((x) => ({ key: x.key, title: x.title }))}
      step={step}
      reached={reached}
      editing={editing}
      onGo={go}
      err={err}
      problem={problem}
      busy={busy}
      finishLabel={editing ? "Save changes" : "Create assistant"}
      finishDisabled={!name.trim()}
      onFinish={save}
      onCancel={onCancel}
      onDelete={editing ? remove : undefined}
      deleteLabel="Delete this assistant"
    >
      {cur === "basics" ? (
        <Basics name={name} description={description} setName={setName} setDescription={setDescription} />
      ) : null}

      {cur === "behave" ? <Behave instructions={instructions} setInstructions={setInstructions} /> : null}

      {cur === "abilities" ? <Abilities tools={tools} setTools={setTools} /> : null}

      {cur === "files" ? (
        <FilesStep
          files={files}
          setFiles={setFiles}
          wantUpload={wantUpload}
          wantOutput={wantOutput}
          setWantUpload={setWantUpload}
          setWantOutput={setWantOutput}
          teach={teach}
          setTeach={setTeach}
          alreadyTaught={instructions.includes(FILE_MARKER)}
        />
      ) : null}

      {cur === "access" ? <AccessStep access={access} setAccess={setAccess} /> : null}

      {cur === "review" ? (
        <Review
          name={name}
          description={description}
          instructions={finalInstructions}
          tools={tools}
          files={files}
          access={editing ? null : access}
          showPrompt={showPrompt}
          setShowPrompt={setShowPrompt}
          go={goTo}
        />
      ) : null}
    </WizardFrame>
  );
}

// --------------------------------------------------------------- step 1 -----

function Basics({
  name,
  description,
  setName,
  setDescription,
}: {
  name: string;
  description: string;
  setName: (v: string) => void;
  setDescription: (v: string) => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">What do you want to call it?</h3>
        <p className="mt-1 text-[15px] muted">This is the name people will see in their list.</p>
      </div>
      <label className="block">
        <span className="label">Name</span>
        <input
          className="field mt-2"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          placeholder="For example: Weekly Sales Helper"
          autoFocus
        />
        <span className="help">It must be different from every other assistant in your workspace.</span>
      </label>
      <label className="block">
        <span className="label">What is it for? (one or two sentences)</span>
        <textarea
          className="field mt-2 min-h-[96px]"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="For example: Answers questions about weekly sales and turns a spreadsheet into a slide deck."
        />
        <span className="help">Shown on the assistant&rsquo;s card so people know when to pick it.</span>
      </label>
    </div>
  );
}

// --------------------------------------------------------------- step 2 -----

function Behave({
  instructions,
  setInstructions,
}: {
  instructions: string;
  setInstructions: (v: string) => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold">How should it behave?</h3>
        <p className="mt-1 text-[15px] muted">
          Think of this as a briefing for a new colleague. You can skip it for now and come back later.
        </p>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-[15px] muted">
        <li>Who is it helping, and what is its job?</li>
        <li>Which tool should it use, and when?</li>
        <li>How should it word its answers: short, formal, friendly?</li>
        <li>What should it never do?</li>
      </ul>
      <label className="block">
        <span className="label">Instructions</span>
        <textarea
          className="field mt-2 min-h-[260px]"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Write your instructions here, in plain sentences."
        />
      </label>
      {!instructions.trim() ? (
        <button type="button" className="btn btn-quiet" onClick={() => setInstructions(EXAMPLE_PROMPT)}>
          Start from an example
        </button>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------- step 3 -----

function Abilities({
  tools,
  setTools,
}: {
  tools: BuilderTool[];
  setTools: (t: BuilderTool[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold">What should it be able to do?</h3>
        <p className="mt-1 text-[15px] muted">
          Give it the tools and information it can use. You can skip this and add them later.
        </p>
      </div>

      {tools.length === 0 ? (
        <p className="rounded-xl p-4 text-[15px] muted" style={{ background: "var(--canvas)" }}>
          Nothing added yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {tools.map((t) => {
            const a = ABILITY[t.type];
            return (
              <li key={t.type + t.ref} className="rounded-xl p-4" style={{ border: "1px solid var(--line)" }}>
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-semibold">{a?.title || t.type.replace(/_/g, " ")}</p>
                    <p className="break-all text-[13px] faint">{t.ref}</p>
                  </div>
                  {!t.readonly ? (
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => setTools(tools.filter((x) => x !== t))}
                    >
                      Remove
                    </button>
                  ) : (
                    <span className="text-[13px] faint">Added in Databricks. Left as it is.</span>
                  )}
                </div>
                {!t.readonly ? (
                  <label className="mt-3 block">
                    <span className="text-[13px] font-medium muted">When should it use this?</span>
                    <input
                      className="field mt-1"
                      value={t.description}
                      onChange={(e) =>
                        setTools(tools.map((x) => (x === t ? { ...x, description: e.target.value } : x)))
                      }
                      placeholder="For example: when someone asks about the weather"
                    />
                  </label>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {adding ? (
        <AddAbility
          have={tools}
          onAdd={(t) => {
            setTools([...tools, t]);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
          <PlusIcon size={16} />
          Add an ability
        </button>
      )}
    </div>
  );
}

function AddAbility({
  have,
  onAdd,
  onCancel,
}: {
  have: BuilderTool[];
  onAdd: (t: BuilderTool) => void;
  onCancel: () => void;
}) {
  const [types, setTypes] = useState<ToolType[]>([]);
  const [kind, setKind] = useState("");
  const [catalogs, setCatalogs] = useState<SourceItem[]>([]);
  const [schemas, setSchemas] = useState<SourceItem[]>([]);
  const [catalog, setCatalog] = useState("");
  const [schema, setSchema] = useState("");
  const [items, setItems] = useState<SourceItem[]>([]);
  const [pick, setPick] = useState("");
  const [typed, setTyped] = useState("");
  const [desc, setDesc] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.builderTypes().then((d) => setTypes(d.types)).catch(() => {});
  }, []);

  // Reset the picker whenever the kind changes.
  useEffect(() => {
    setCatalog("");
    setSchema("");
    setSchemas([]);
    setItems([]);
    setPick("");
    setTyped("");
    setNote("");
    if (!kind) return;
    setLoading(true);
    const first = BROWSE.has(kind) ? api.builderSources("catalogs") : api.builderSources(kind);
    first
      .then((d) => {
        if (BROWSE.has(kind)) setCatalogs(d.items);
        else setItems(d.items);
        setNote(d.note);
      })
      .catch((e) => setNote(e.message))
      .finally(() => setLoading(false));
  }, [kind]);

  useEffect(() => {
    if (!BROWSE.has(kind) || !catalog) return;
    setSchema("");
    setItems([]);
    api.builderSources("schemas", catalog).then((d) => setSchemas(d.items)).catch(() => {});
  }, [catalog, kind]);

  useEffect(() => {
    if (!BROWSE.has(kind) || !catalog || !schema) return;
    setPick("");
    api.builderSources(kind, catalog, schema).then((d) => {
      setItems(d.items);
      setNote(d.note);
    }).catch(() => {});
  }, [schema, catalog, kind]);

  const ref = (typed || pick).trim();
  const taken = have.some((t) => t.type === kind && t.ref === ref);
  const current = types.find((t) => t.type === kind);
  const a = ABILITY[kind];

  function add() {
    if (!ref || taken) return;
    onAdd({
      type: kind,
      ref,
      description: desc.trim() || items.find((i) => i.value === ref)?.detail || "",
    });
  }

  return (
    <div className="rounded-xl p-5" style={{ border: "1px solid var(--brand)", background: "var(--canvas)" }}>
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[15px] font-semibold">
          {kind ? a?.title || "Add an ability" : "What kind of ability?"}
        </h4>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {!kind ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {types.map((t) => {
            const info = ABILITY[t.type];
            return (
              <button key={t.type} type="button" className="choice" aria-pressed={false} onClick={() => setKind(t.type)}>
                <span>
                  <span className="block text-[15px] font-semibold">{info?.title || t.label}</span>
                  <span className="mt-0.5 block text-[13px] muted">{info?.blurb || t.label}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <p className="text-[15px] muted">{a?.blurb}</p>

          {BROWSE.has(kind) ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-[13px] font-medium muted">1. Catalog (the top-level area)</span>
                <select className="field mt-1" value={catalog} onChange={(e) => setCatalog(e.target.value)}>
                  <option value="">{loading ? "Loading…" : "Choose…"}</option>
                  {catalogs.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[13px] font-medium muted">2. Schema (the group inside it)</span>
                <select
                  className="field mt-1"
                  value={schema}
                  onChange={(e) => setSchema(e.target.value)}
                  disabled={!catalog}
                >
                  <option value="">Choose…</option>
                  {schemas.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}

          <label className="block">
            <span className="text-[13px] font-medium muted">
              {BROWSE.has(kind) ? `3. Choose the ${a?.noun}` : `Choose the ${a?.noun}`}
            </span>
            <select
              className="field mt-1"
              value={pick}
              onChange={(e) => {
                setPick(e.target.value);
                setTyped("");
              }}
              disabled={loading || items.length === 0}
            >
              <option value="">
                {loading ? "Loading…" : items.length ? "Choose one…" : BROWSE.has(kind) ? "Pick a catalog and schema first" : "Nothing found"}
              </option>
              {items.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                  {i.detail ? ` — ${i.detail}` : ""}
                </option>
              ))}
            </select>
          </label>

          {note ? <p className="help">{note}</p> : null}

          <details>
            <summary className="cursor-pointer text-[13px] font-medium muted">
              Advanced: type the exact name instead
            </summary>
            <input
              className="field mt-2"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={
                BROWSE.has(kind) || kind === "vector_search_index"
                  ? "catalog.schema.name"
                  : "The exact name or id"
              }
            />
          </details>

          <label className="block">
            <span className="text-[13px] font-medium muted">When should it use this? (optional)</span>
            <input
              className="field mt-1"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="For example: when someone asks about sales"
            />
          </label>

          {current && !current.confirmed ? (
            <p className="help">
              Databricks has not published the exact setup for this kind of ability, so it might be
              rejected. If it is, nothing is created and you will be told why.
            </p>
          ) : null}
          {taken ? <p className="help">You have already added that one.</p> : null}

          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn btn-primary" onClick={add} disabled={!ref || taken}>
              Add this ability
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setKind("")}>
              Choose a different kind
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------- step 4 -----

function FilesStep({
  files,
  setFiles,
  wantUpload,
  wantOutput,
  setWantUpload,
  setWantOutput,
  teach,
  setTeach,
  alreadyTaught,
}: {
  files: FileSettings;
  setFiles: (f: FileSettings) => void;
  wantUpload: boolean;
  wantOutput: boolean;
  setWantUpload: (v: boolean) => void;
  setWantOutput: (v: boolean) => void;
  teach: boolean;
  setTeach: (v: boolean) => void;
  alreadyTaught: boolean;
}) {
  const chosen = parseTypes(files.accepts);
  const known = FILE_TYPES.map((t) => t.ext);
  const other = chosen.filter((e) => !known.includes(e)).join(", ");

  function setTypes(list: string[]) {
    setFiles({ ...files, accepts: Array.from(new Set(list)).join(", ") });
  }
  function toggleType(ext: string) {
    setTypes(chosen.includes(ext) ? chosen.filter((e) => e !== ext) : [...chosen, ext]);
  }

  return (
    <div className="space-y-7">
      <div>
        <h3 className="text-lg font-semibold">Will it work with files?</h3>
        <p className="mt-1 text-[15px] muted">
          For example: someone uploads a spreadsheet and gets a presentation back. Skip this if it
          only answers questions.
        </p>
      </div>

      <section className="space-y-3">
        <p className="label">Can people send it a file?</p>
        <YesNo
          value={wantUpload}
          onChange={(v) => {
            setWantUpload(v);
            if (!v) setFiles({ ...files, upload_volume: "", accepts: "" });
          }}
        />
        {wantUpload ? (
          <div className="space-y-5 pl-1">
            <VolumeField
              label="Where should the files they send be kept?"
              hint="Each file is saved in a folder called “uploads” inside this folder."
              value={files.upload_volume}
              suffix="/uploads"
              onChange={(v) => setFiles({ ...files, upload_volume: v })}
            />
            <div>
              <p className="label">Which kinds of file are allowed?</p>
              <p className="help">Tick the ones you want. Tick none to allow any kind of file.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {FILE_TYPES.map((t) => {
                  const on = chosen.includes(t.ext);
                  return (
                    <button
                      key={t.ext}
                      type="button"
                      className="step-pill"
                      aria-pressed={on}
                      data-done={on ? "true" : "false"}
                      style={on ? { borderColor: "var(--brand)", background: "var(--brand-soft)", color: "var(--ink)" } : undefined}
                      onClick={() => toggleType(t.ext)}
                    >
                      <span className="step-num">{on ? "✓" : ""}</span>
                      {t.label} (.{t.ext})
                    </button>
                  );
                })}
              </div>
              <label className="mt-3 block">
                <span className="block text-[13px] font-medium muted">Any others? Separate with commas</span>
                <input
                  className="field mt-1 max-w-xs"
                  value={other}
                  placeholder="for example: json, zip"
                  onChange={(e) =>
                    setTypes([...chosen.filter((x) => known.includes(x)), ...parseTypes(e.target.value)])
                  }
                />
              </label>
            </div>
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <p className="label">Will it give back a file to download?</p>
        <YesNo
          value={wantOutput}
          onChange={(v) => {
            setWantOutput(v);
            if (!v) setFiles({ ...files, output_volume: "" });
          }}
        />
        {wantOutput ? (
          <div className="pl-1">
            <VolumeField
              label="Where should it save the files it makes?"
              hint="It is told to save results in a folder called “output” inside this folder. Only files saved here can be downloaded."
              value={files.output_volume}
              suffix="/output"
              onChange={(v) => setFiles({ ...files, output_volume: v })}
            />
          </div>
        ) : null}
      </section>

      {(wantUpload || wantOutput) && !alreadyTaught ? (
        <label className="flex cursor-pointer items-start gap-3 rounded-xl p-4" style={{ background: "var(--canvas)", border: "1px solid var(--line)" }}>
          <input
            type="checkbox"
            className="mt-1 h-5 w-5"
            checked={teach}
            onChange={(e) => setTeach(e.target.checked)}
          />
          <span>
            <span className="block text-[15px] font-semibold">Teach it how to use these folders (recommended)</span>
            <span className="help block">
              It only finds out about the files from the chat message. This adds a short note to its
              instructions so it passes the file locations to its tools and tells people where the
              result is. You will see it on the last step.
            </span>
          </span>
        </label>
      ) : null}
    </div>
  );
}

function YesNo({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="grid max-w-sm grid-cols-2 gap-3" role="group">
      <button type="button" className="choice !items-center !justify-center" aria-pressed={!value} onClick={() => onChange(false)}>
        <span className="text-[15px] font-semibold">No</span>
      </button>
      <button type="button" className="choice !items-center !justify-center" aria-pressed={value} onClick={() => onChange(true)}>
        <span className="text-[15px] font-semibold">Yes</span>
      </button>
    </div>
  );
}

// --------------------------------------------------------------- step 5 -----

function Review({
  name,
  description,
  instructions,
  tools,
  files,
  access,
  showPrompt,
  setShowPrompt,
  go,
}: {
  name: string;
  description: string;
  instructions: string;
  tools: BuilderTool[];
  files: FileSettings;
  access: Access[] | null;
  showPrompt: boolean;
  setShowPrompt: (v: boolean) => void;
  go: (k: StepKey) => void;
}) {
  const types = parseTypes(files.accepts);
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Check everything looks right</h3>
        <p className="mt-1 text-[15px] muted">
          Nothing is saved until you press the button at the bottom. Use “Change” to fix anything.
        </p>
      </div>

      <Section title="Name and purpose" onChange={() => go("basics")}>
        <p className="text-[15px] font-semibold">{name || "—"}</p>
        <p className="text-[15px] muted">{description || "No description."}</p>
      </Section>

      <Section title="Instructions" onChange={() => go("behave")}>
        {instructions.trim() ? (
          <>
            <p className={"whitespace-pre-wrap text-[15px] muted " + (showPrompt ? "" : "line-clamp-4")}>
              {instructions}
            </p>
            <button type="button" className="mt-1 text-[13px] underline" onClick={() => setShowPrompt(!showPrompt)}>
              {showPrompt ? "Show less" : "Show all"}
            </button>
          </>
        ) : (
          <p className="text-[15px] muted">None. It will use its general behaviour.</p>
        )}
      </Section>

      <Section title="Abilities" onChange={() => go("abilities")}>
        {tools.length === 0 ? (
          <p className="text-[15px] muted">None added.</p>
        ) : (
          <ul className="space-y-1.5">
            {tools.map((t) => (
              <li key={t.type + t.ref} className="text-[15px]">
                <b>{ABILITY[t.type]?.title || t.type.replace(/_/g, " ")}</b>
                <span className="break-all text-[13px] faint"> — {t.ref}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Files" onChange={() => go("files")}>
        {!files.upload_volume && !files.output_volume ? (
          <p className="text-[15px] muted">It does not work with files.</p>
        ) : (
          <ul className="space-y-1.5 text-[15px]">
            {files.upload_volume ? (
              <li>
                People can send files{types.length ? ` (${types.map((t) => "." + t).join(", ")})` : " of any kind"}.
                <span className="block break-all text-[13px] faint">Kept in {files.upload_volume}</span>
              </li>
            ) : null}
            {files.output_volume ? (
              <li>
                It gives back files to download.
                <span className="block break-all text-[13px] faint">Saved in {files.output_volume}</span>
              </li>
            ) : null}
          </ul>
        )}
      </Section>

      {access ? (
        <Section title="Who can use it" onChange={() => go("access")}>
          {access.length === 0 ? (
            <p className="text-[15px] muted">
              Nobody yet. You can add people later on the Access page.
            </p>
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
    </div>
  );
}
