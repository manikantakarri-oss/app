"use client";

import { useEffect, useState } from "react";
import { api, KnowledgeDetail, KnowledgeSource } from "@/lib/api";
import { Spinner } from "./bits";
import { PlusIcon } from "./icons";
import { Access, AccessStep, Finished, Section, VolumeField, WizardFrame } from "./BuilderParts";

const ALL_STEPS = [
  { key: "basics", title: "Name it" },
  { key: "docs", title: "Your documents" },
  { key: "guide", title: "Instructions" },
  { key: "access", title: "Who can use it" },
  { key: "review", title: "Review" },
] as const;

type StepKey = (typeof ALL_STEPS)[number]["key"];

const MAX = 10;
const blank = (): KnowledgeSource => ({ volume: "", subfolder: "", name: "", description: "" });

/** The name Databricks will use: letters, numbers and dashes only. */
function slug(text: string) {
  let s = text.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 63).replace(/-+$/g, "");
  if (s.length < 4) s = (s + "-assistant").replace(/^-+/, "").slice(0, 63);
  return s;
}

/** Create or edit a Knowledge Assistant: an assistant that answers from documents.
 *  Same frame and access step as the other wizards, so it feels like one tool.
 *
 *  Editing changes the name people see, the description and the instructions.
 *  The document folders are shown but not rewritten here. */
export function KnowledgeWizard({
  id,
  onCancel,
  onFinished,
}: {
  id: string | null;
  onCancel: () => void;
  onFinished: (d: Finished) => void;
}) {
  const editing = !!id;
  const steps = editing ? ALL_STEPS.filter((x) => x.key !== "access") : ALL_STEPS;
  const keys: StepKey[] = steps.map((x) => x.key);
  const last = steps.length - 1;

  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [name, setName] = useState("");
  const [apiName, setApiName] = useState("");
  const [apiTouched, setApiTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [sources, setSources] = useState<KnowledgeSource[]>([blank()]);
  const [existing, setExisting] = useState<KnowledgeDetail["sources"]>([]);
  const [access, setAccess] = useState<Access[]>([]);
  const [loading, setLoading] = useState(!!id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!id) return;
    api
      .knowledgeGet(id)
      .then((k) => {
        setName(k.display_name);
        setApiName(k.api_name);
        setDescription(k.description);
        setInstructions(k.instructions);
        setExisting(k.sources);
        setReached(last);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Until the person edits it themselves, the Databricks name follows the friendly one.
  const dbName = apiTouched ? apiName : slug(name);
  const cur = keys[step];

  const sourcesOk = sources.length > 0 && sources.every((s) => s.volume && s.description.trim());
  const problem =
    cur === "basics" && !name.trim()
      ? "Give it a name to continue."
      : cur === "basics" && !description.trim()
        ? "Say what it can answer questions about to continue."
        : cur === "docs" && !editing && !sourcesOk
          ? "Choose a folder and describe what is in it, for every folder."
          : "";

  function go(i: number) {
    setErr("");
    setStep(i);
    setReached((r) => Math.max(r, i));
  }
  const goTo = (k: StepKey) => go(Math.max(0, keys.indexOf(k)));

  async function save() {
    setBusy(true);
    setErr("");
    try {
      if (id) {
        const r = await api.knowledgeUpdate(id, { display_name: name, description, instructions });
        onFinished({ kind: "saved", name, variant: "docs", warnings: r.warnings });
      } else {
        const r = await api.knowledgeCreate({
          display_name: name,
          api_name: apiTouched ? apiName : "",
          description,
          instructions,
          sources,
          access,
        });
        onFinished({
          kind: "created",
          name,
          variant: "docs",
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
      await api.knowledgeDelete(id);
      onFinished({ kind: "deleted", name, variant: "docs" });
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }

  if (loading) return <Spinner label="Loading…" />;

  const setSource = (i: number, patch: Partial<KnowledgeSource>) =>
    setSources(sources.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <WizardFrame
      title={editing ? "Change a document assistant" : "Create a document assistant"}
      steps={steps.map((x) => ({ key: x.key, title: x.title }))}
      step={step}
      reached={reached}
      editing={editing}
      onGo={go}
      err={err}
      problem={problem}
      busy={busy}
      finishLabel={editing ? "Save changes" : "Create document assistant"}
      finishDisabled={!name.trim() || !description.trim() || (!editing && !sourcesOk)}
      onFinish={save}
      onCancel={onCancel}
      onDelete={editing ? remove : undefined}
      deleteLabel="Delete this document assistant"
    >
      {cur === "basics" ? (
        <div className="space-y-6">
          <div>
            <h3 className="text-lg font-semibold">What do you want to call it?</h3>
            <p className="mt-1 text-[15px] muted">
              People will ask it questions and it will answer from your documents, such as PDFs and Word files.
            </p>
          </div>
          <label className="block">
            <span className="label">Name</span>
            <input
              className="field mt-2"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              placeholder="For example: HR Policy Expert"
              autoFocus
            />
          </label>
          <label className="block">
            <span className="label">What can it answer questions about?</span>
            <textarea
              className="field mt-2 min-h-[96px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="For example: Answers questions about our HR policies, leave and travel rules."
            />
            <span className="help">Required. Shown to people so they know when to use it.</span>
          </label>
          {!editing ? (
            <details>
              <summary className="cursor-pointer text-[13px] font-medium muted">
                Advanced: the name Databricks will use
              </summary>
              <input
                className="field mt-2 max-w-md"
                value={dbName}
                onChange={(e) => {
                  setApiTouched(true);
                  setApiName(e.target.value);
                }}
                aria-label="Databricks name"
              />
              <span className="help">
                Databricks only allows letters, numbers and dashes, 4 to 63 characters. It is made from the name
                above and must be different from every other assistant.
              </span>
            </details>
          ) : (
            <p className="help">Databricks name: {apiName} (cannot be changed).</p>
          )}
        </div>
      ) : null}

      {cur === "docs" ? (
        editing ? (
          <div className="space-y-5">
            <div>
              <h3 className="text-lg font-semibold">Its documents</h3>
              <p className="mt-1 text-[15px] muted">
                To add, remove or change the document folders, open this assistant in Databricks. They are shown here
                for reference.
              </p>
            </div>
            {existing.length === 0 ? (
              <p className="rounded-xl p-4 text-[15px] muted" style={{ background: "var(--canvas)" }}>
                The document list could not be read here.
              </p>
            ) : (
              <ul className="space-y-3">
                {existing.map((s, i) => (
                  <li key={s.name + i} className="rounded-xl p-4" style={{ border: "1px solid var(--line)" }}>
                    <p className="text-[15px] font-semibold">{s.name || "Documents"}</p>
                    {s.path ? <p className="break-all text-[13px] faint">{s.path}</p> : null}
                    <p className="mt-1 text-[15px] muted">{s.description}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-semibold">Where are your documents?</h3>
              <p className="mt-1 text-[15px] muted">
                Add up to {MAX} folders of files, such as PDF, Word and PowerPoint. Describe each one, because the
                assistant uses that to decide when to look there.
              </p>
            </div>

            {sources.map((s, i) => (
              <div
                key={i}
                className="space-y-5 rounded-xl p-5"
                style={{ border: "1px solid var(--line)", background: "var(--canvas)" }}
              >
                <div className="flex items-center justify-between gap-3">
                  <h4 className="text-[15px] font-semibold">Folder {i + 1}</h4>
                  {sources.length > 1 ? (
                    <button
                      type="button"
                      className="btn btn-quiet !min-h-[36px] !px-3"
                      onClick={() => setSources(sources.filter((_, j) => j !== i))}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>

                <VolumeField
                  label="Which folder holds the files?"
                  hint="Files in this folder are read, including its subfolders."
                  value={s.volume}
                  suffix=""
                  onChange={(v) => setSource(i, { volume: v })}
                />

                <label className="block">
                  <span className="block text-[13px] font-medium muted">A folder inside it (optional)</span>
                  <input
                    className="field mt-1 max-w-md"
                    value={s.subfolder}
                    onChange={(e) => setSource(i, { subfolder: e.target.value })}
                    placeholder="For example: policies/2026"
                  />
                </label>

                <label className="block">
                  <span className="label">What is in this folder?</span>
                  <textarea
                    className="field mt-2 min-h-[84px]"
                    value={s.description}
                    onChange={(e) => setSource(i, { description: e.target.value })}
                    placeholder="For example: HR policy documents covering leave, travel and conduct."
                  />
                  <span className="help">Required. Describe it in as much detail as you can.</span>
                </label>

                <details>
                  <summary className="cursor-pointer text-[13px] font-medium muted">Advanced: name this folder</summary>
                  <input
                    className="field mt-2 max-w-md"
                    value={s.name}
                    onChange={(e) => setSource(i, { name: e.target.value })}
                    placeholder="Optional. Made from the folder name if left empty"
                  />
                </details>
              </div>
            ))}

            {sources.length < MAX ? (
              <button type="button" className="btn btn-quiet" onClick={() => setSources([...sources, blank()])}>
                <PlusIcon size={16} />
                Add another folder
              </button>
            ) : null}
            <p className="help">
              For now, documents come from folders (volumes). Other kinds of source can be added in Databricks.
            </p>
          </div>
        )
      ) : null}

      {cur === "guide" ? (
        <div className="space-y-5">
          <div>
            <h3 className="text-lg font-semibold">How should it answer?</h3>
            <p className="mt-1 text-[15px] muted">Optional. You can skip this and come back later.</p>
          </div>
          <label className="block">
            <span className="label">Instructions</span>
            <textarea
              className="field mt-2 min-h-[200px]"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="For example: Answer in short, plain sentences. Always name the policy you used. If the documents do not say, tell the person to ask HR."
            />
            <span className="help">Guidelines for how it should respond: format, tone and what to do when unsure.</span>
          </label>
        </div>
      ) : null}

      {cur === "access" ? (
        <AccessStep
          access={access}
          setAccess={setAccess}
          note="They can ask it questions but not change it. The access is applied once Databricks has finished reading the documents and started it, which can take several minutes."
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
            <p className="text-[15px] font-semibold">{name || "—"}</p>
            <p className="text-[15px] muted">{description || "—"}</p>
            <p className="mt-1 text-[13px] faint">Databricks name: {editing ? apiName : dbName}</p>
          </Section>

          <Section title="Documents" onChange={() => goTo("docs")}>
            {editing ? (
              <p className="text-[15px] muted">
                {existing.length ? `${existing.length} folder${existing.length === 1 ? "" : "s"}, changed in Databricks.` : "Changed in Databricks."}
              </p>
            ) : (
              <ul className="space-y-2">
                {sources.map((s, i) => (
                  <li key={i} className="text-[15px]">
                    <b className="break-all">
                      {s.volume}
                      {s.subfolder ? "/" + s.subfolder.replace(/^\/+/, "") : ""}
                    </b>
                    <span className="block text-[13px] faint">{s.description}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Instructions" onChange={() => goTo("guide")}>
            {instructions.trim() ? (
              <p className="whitespace-pre-wrap text-[15px] muted">{instructions}</p>
            ) : (
              <p className="text-[15px] muted">None. It will use its general behaviour.</p>
            )}
          </Section>

          {!editing ? (
            <Section title="Who can use it" onChange={() => goTo("access")}>
              {access.length === 0 ? (
                <p className="text-[15px] muted">Nobody yet. You can add people later on the Access page.</p>
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

          <p className="help">
            Databricks reads the documents when it is created, so it can take several minutes before it can answer.
          </p>
        </div>
      ) : null}
    </WizardFrame>
  );
}
