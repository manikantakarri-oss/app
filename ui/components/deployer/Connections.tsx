"use client";

import { useRef, useState } from "react";
import { dapi, GamNetwork } from "@/lib/deployer";
import { ErrorBox, Notice, Select, Spinner } from "@/components/bits";
import { Field } from "./parts";

/** A client's Google Ad Manager connection, used by the media planner tool.
 *  The key is checked against Google first (it must see the chosen network),
 *  then kept encrypted like the workspace secret; each deploy puts it in the
 *  client's own workspace. Saved on its own, not with the settings form. */
export function GamConnection({
  clientId,
  network,
  account,
  keySetAt,
  onSaved,
}: {
  clientId: string;
  network: string;
  account: string;
  keySetAt: string;
  onSaved: () => void;
}) {
  const connected = !!network && !!keySetAt;
  const [editing, setEditing] = useState(false);
  const [keyText, setKeyText] = useState("");
  const [fileName, setFileName] = useState("");
  const [found, setFound] = useState<{ account: string; networks: GamNetwork[] } | null>(null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState<"" | "test" | "save" | "remove">("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  function reset() {
    setKeyText("");
    setFileName("");
    setFound(null);
    setPick("");
    setErr("");
    setEditing(false);
    if (input.current) input.current.value = "";
  }

  async function onFile(file: File | undefined) {
    setErr("");
    setMsg("");
    setFound(null);
    setPick("");
    if (!file) return;
    if (file.size > 20000) {
      setErr("That file is too large to be a service account key.");
      return;
    }
    const text = await file.text();
    setKeyText(text);
    setFileName(file.name);
    setBusy("test");
    try {
      const r = await dapi.gamTest(text);
      setFound(r);
      if (r.networks.length === 1) setPick(r.networks[0].code);
      else if (r.networks.some((n) => n.code === network)) setPick(network);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy("");
    }
  }

  async function save() {
    setBusy("save");
    setErr("");
    try {
      await dapi.gamSave(clientId, keyText, pick);
      setMsg("Connected. Their portal gets it on the next deploy.");
      reset();
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy("");
    }
  }

  async function remove() {
    setBusy("remove");
    setErr("");
    try {
      await dapi.gamRemove(clientId);
      setMsg("Disconnected. The key is removed from their workspace on the next deploy.");
      setConfirmRemove(false);
      reset();
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy("");
    }
  }

  const showForm = !connected || editing;

  return (
    <div className="space-y-4">
      {connected && !editing ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[14px] font-medium">
              <span className="status-pill status-ready mr-2">Connected</span>
              Network {network}
            </p>
            <p className="mt-1 break-all text-[13px] faint">
              {account ? `As ${account}. ` : ""}Key kept encrypted; it can be replaced, never read back.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-quiet" onClick={() => { setEditing(true); setMsg(""); }}>
              Replace key
            </button>
            {confirmRemove ? (
              <>
                <button type="button" className="btn btn-primary"
                  style={{ ["--btn-from" as any]: "var(--err)", ["--btn-to" as any]: "var(--err)" }}
                  disabled={busy === "remove"} onClick={remove}>
                  {busy === "remove" ? "Disconnecting…" : "Yes, disconnect"}
                </button>
                <button type="button" className="btn btn-quiet" onClick={() => setConfirmRemove(false)}>
                  Keep it
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-quiet" onClick={() => setConfirmRemove(true)}>
                Disconnect
              </button>
            )}
          </div>
        </div>
      ) : null}

      {showForm ? (
        <div className="space-y-4">
          {!connected ? (
            <p className="text-[13px] muted">
              Needed by the media planner tool. Ask the client for a Google Cloud service account key whose account was added as a user in
              their Google Ad Manager network (with API access turned on).
            </p>
          ) : null}
          <Field label="Service account key" hint="The .json file from Google Cloud. It is checked with Google before anything is saved.">
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="btn btn-quiet" disabled={!!busy} onClick={() => input.current?.click()}>
                {fileName ? "Choose another file" : "Choose key file"}
              </button>
              <input ref={input} type="file" accept=".json,application/json" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
              {busy === "test" ? <Spinner label="Checking with Google…" /> : fileName ? <span className="text-[13px] muted break-all">{fileName}</span> : null}
            </div>
          </Field>
          {found ? (
            found.networks.length ? (
              <Field label="Ad Manager network" hint={`The key signs in as ${found.account}.`}>
                <div className="max-w-md">
                  <Select
                    value={pick}
                    onChange={setPick}
                    placeholder="Choose the network"
                    options={found.networks.map((n) => ({
                      value: n.code,
                      label: n.name || n.code,
                      detail: [n.code, n.currency, n.time_zone].filter(Boolean).join(" · "),
                    }))}
                  />
                </div>
              </Field>
            ) : (
              <Notice>
                The key works, but {found.account} is not a user in any Google Ad Manager network yet. Ask the client to add it (Admin, Access
                and authorisation, Users) and try again.
              </Notice>
            )
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" disabled={!pick || !keyText || !!busy} onClick={save}>
              {busy === "save" ? "Saving…" : "Save connection"}
            </button>
            {editing ? (
              <button type="button" className="btn btn-quiet" disabled={!!busy} onClick={reset}>
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <ErrorBox>{err}</ErrorBox>
      {msg ? <p className="text-[13px] muted" role="status">{msg}</p> : null}
    </div>
  );
}
