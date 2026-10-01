"""Create and edit Knowledge Assistants ("answer questions from my documents").

A Knowledge Assistant is an Agent Bricks object (`/api/2.1/knowledge-assistants`,
Beta) that turns documents into a question-answering assistant. It appears in
Databricks and, once its serving endpoint exists, in this portal.

What is confirmed and what is not
---------------------------------
The create screen in Databricks (and the API reference) show: a name of letters,
numbers and dashes, a required description, optional instructions, and up to ten
knowledge sources, each with a type, a source, a name and a required "describe
the content". The names `display_name`, `description`, `instructions`,
`source_type` ("files" for "Files in a Volume") are documented. **Not documented
anywhere this was built from**: the nested field that carries a volume path
(`files.path` is used here), the sources sub-path (`knowledge-sources`) and the
sync call. Creation is therefore all-or-nothing, so a rejected source deletes the
half-built assistant and the message from Databricks is shown as it came. Only
the "Files in a Volume" source type is offered; index and table sources would
mean guessing more field names.

Identity
--------
Same rule as the other builders (`builder.act`): the admin's token first, the
app's service principal only if Databricks says the token lacks the scope, which
is expected here (`knowledge-assistants` is not a requestable Apps user scope).
The admin and the portal are then given CAN_MANAGE. Edits and deletes use the
admin's own token only, with no fallback.

Friendly name versus Databricks name
------------------------------------
Databricks only allows letters, numbers and dashes in the name; people want
"HR Policy Expert". So the friendly name is stored in the endpoint's
`display_name` tag (what the portal shows) and the Databricks name is derived from
it, editable under Advanced.
"""
from __future__ import annotations

import logging
import re
import time

import access
import builder
from dbx import DbxError, app_token, call

log = logging.getLogger("portal.knowledge")

KAS = "/api/2.1/knowledge-assistants"
PERMS = "/api/2.0/permissions/knowledge-assistants/"
MAX_SOURCES = 10

NAME_RE = r"^[A-Za-z0-9-]{4,63}$"


def _check_id(ka_id: str) -> str:
    if not re.match(r"^[\w\-]{1,64}$", ka_id or ""):
        raise DbxError("invalid assistant id", 400)
    return ka_id


def slug(text: str) -> str:
    """'HR Policy Expert' -> 'hr-policy-expert': letters, numbers and dashes, 4-63."""
    s = re.sub(r"[^A-Za-z0-9]+", "-", text or "").strip("-").lower()[:63].strip("-")
    if len(s) < 4:
        s = (s + "-assistant").strip("-")[:63]
    return s


def _ka_id(k: dict) -> str:
    return str(k.get("knowledge_assistant_id") or k.get("id") or (k.get("name") or "").rsplit("/", 1)[-1] or "")


def clean(payload: dict) -> dict:
    """Validate what the UI sent. Raises DbxError(400)."""
    friendly = (payload.get("display_name") or "").strip()
    if not friendly:
        raise DbxError("A name is required.", 400)
    if len(friendly) > 120:
        raise DbxError("The name is too long (120 characters at most).", 400)

    api_name = (payload.get("api_name") or "").strip() or slug(friendly)
    if not re.match(NAME_RE, api_name):
        raise DbxError(
            "The Databricks name can only use letters, numbers and dashes, 4 to 63 characters.", 400
        )

    description = (payload.get("description") or "").strip()
    if not description:
        raise DbxError("Say what it can answer questions about. Databricks needs a description.", 400)

    instructions = (payload.get("instructions") or "").strip()
    if len(instructions) > 8000:
        raise DbxError("The instructions are too long (8000 characters at most).", 400)

    sources, names = [], set()
    for s in payload.get("sources") or []:
        vol = (s.get("volume") or "").strip()
        if not re.match(r"^[\w\-]+\.[\w\-]+\.[\w\-]+$", vol):
            raise DbxError("Each document folder must look like catalog.schema.volume, got '" + vol + "'.", 400)
        sub = (s.get("subfolder") or "").strip().strip("/")
        if sub and not re.match(r"^[\w\-.]+(/[\w\-.]+)*$", sub):
            raise DbxError("The subfolder '" + sub + "' can only use letters, numbers, dashes, dots and slashes.", 400)
        if ".." in sub.split("/"):
            raise DbxError("A subfolder cannot use '..'.", 400)
        desc = (s.get("description") or "").strip()
        if not desc:
            raise DbxError("Describe what is in each document folder. The assistant uses it to decide when to look there.", 400)
        nm = slug((s.get("name") or "").strip() or vol.rsplit(".", 1)[-1])
        base, n = nm, 2
        while nm in names:
            nm = (base[:58] + "-" + str(n))
            n += 1
        names.add(nm)
        sources.append({"name": nm, "description": desc[:1000], "volume": vol, "subfolder": sub})
    if len(sources) > MAX_SOURCES:
        raise DbxError("A Knowledge Assistant can use at most %d document folders." % MAX_SOURCES, 400)
    if not sources:
        raise DbxError("Add at least one folder of documents.", 400)

    return {
        "display_name": friendly,
        "api_name": api_name,
        "description": description,
        "instructions": instructions,
        "sources": sources,
        "access": builder.clean_access(payload.get("access") or []),
    }


def volume_path(volume: str, subfolder: str = "") -> str:
    """catalog.schema.volume (+ subfolder) -> /Volumes/catalog/schema/volume/subfolder"""
    return "/Volumes/" + volume.replace(".", "/") + (("/" + subfolder) if subfolder else "")


def _source_body(src: dict) -> dict:
    return {
        "display_name": src["name"],
        "description": src["description"],
        "source_type": "files",
        "files": {"path": volume_path(src["volume"], src["subfolder"])},
    }


# --- operations -------------------------------------------------------------

def list_assistants(user_tok: str) -> list:
    d = call("GET", KAS, user_tok, headers=builder._headers())
    return [
        {
            "ka_id": _ka_id(k),
            "display_name": k.get("display_name") or "",
            "description": k.get("description") or "",
            "state": k.get("state") or "",
            "endpoint_name": k.get("endpoint_name") or "",
        }
        for k in d.get("knowledge_assistants") or []
    ]


def get_assistant(ka_id: str, user_tok: str) -> dict:
    _check_id(ka_id)
    k = call("GET", KAS + "/" + ka_id, user_tok, headers=builder._headers())
    sources = []
    try:
        d = call("GET", KAS + "/" + ka_id + "/knowledge-sources", user_tok, headers=builder._headers(), quiet=True)
        for s in d.get("knowledge_sources") or []:
            f = s.get("files") or {}
            sources.append({
                "name": s.get("display_name") or "",
                "description": s.get("description") or "",
                "type": s.get("source_type") or "",
                "path": f.get("path") or "",
            })
    except DbxError:
        pass  # the list is informational; the editable fields do not depend on it
    friendly = ""
    ep = k.get("endpoint_name") or ""
    if ep:
        try:
            friendly = access._tags(call("GET", "/api/2.0/serving-endpoints/" + ep, app_token(), quiet=True)).get("display_name", "")
        except DbxError:
            pass
    return {
        "ka_id": _ka_id(k),
        "api_name": k.get("display_name") or "",
        "display_name": friendly or k.get("display_name") or "",
        "description": k.get("description") or "",
        "instructions": k.get("instructions") or "",
        "state": k.get("state") or "",
        "endpoint_name": ep,
        "sources": sources,
    }


def create(spec: dict, who: dict, user_tok: str) -> dict:
    body = {"display_name": spec["api_name"], "description": spec["description"]}
    if spec["instructions"]:
        body["instructions"] = spec["instructions"]
    ka, by = builder.act("POST", KAS, user_tok, json=body)
    kid = _ka_id(ka)
    if not kid:
        raise DbxError("Databricks created the assistant but returned no id.", 502)

    try:
        for src in spec["sources"]:
            builder.act("POST", KAS + "/" + kid + "/knowledge-sources", user_tok,
                        params={"knowledge_source_id": src["name"]}, json=_source_body(src))
    except DbxError as exc:
        # Do not leave a half-built assistant holding the unique name.
        try:
            builder.act("DELETE", KAS + "/" + kid, user_tok)
        except DbxError:
            log.warning("could not remove half-built knowledge assistant %s", kid)
        raise DbxError("Could not attach a document folder, so nothing was created: " + str(exc)[:260], exc.status)

    warnings = []
    # Reading the documents starts the indexing. Best effort: if this call does not
    # exist or is refused, the assistant still indexes on its own schedule.
    try:
        builder.act("POST", KAS + "/" + kid + "/knowledge-sources:sync", user_tok, json={})
    except DbxError as exc:
        log.info("knowledge sync for %s not started (%s)", kid, str(exc)[:120])

    try:
        _share(kid, who)
    except DbxError as exc:
        warnings.append(
            "It was created, but you could not be made its manager automatically (%s). "
            "Ask a workspace admin to grant you CAN_MANAGE on it." % str(exc)[:100]
        )
    log.info("knowledge assistant %s created by %s as %s with %d sources", kid, who.get("user_name"), by, len(spec["sources"]))
    return {
        "ka_id": kid,
        "endpoint_name": ka.get("endpoint_name") or "",
        "acted_as": by,
        "warnings": warnings,
        "access_pending": len(spec["access"]),
    }


def _share(ka_id: str, who: dict) -> None:
    """The admin who asked and the portal both get CAN_MANAGE (idempotent)."""
    acl = []
    if who.get("user_name"):
        acl.append({"user_name": who["user_name"], "permission_level": "CAN_MANAGE"})
    sp = builder._portal_sp(app_token())
    if sp:
        acl.append({"service_principal_name": sp, "permission_level": "CAN_MANAGE"})
    if acl:
        call("PATCH", PERMS + ka_id, app_token(), json={"access_control_list": acl})


def finish(ka_id: str, spec: dict, who: dict) -> None:
    """Background: wait for the endpoint, then tag and share it like any agent.

    A Knowledge Assistant reads its documents before it is ready, so its endpoint
    can take several minutes longer than a supervisor's. Once it exists the work is
    identical, so it is handed to `builder.finish_provisioning`. The Agent Bricks id
    is deliberately NOT written as the `agent_id` tag: that tag points at the
    supervisor-agents permission list, which is not this assistant's.
    """
    tok = app_token()
    endpoint = ""
    for _ in range(100):  # ~10 minutes
        try:
            k = call("GET", KAS + "/" + ka_id, tok, headers=builder._headers(), quiet=True)
            endpoint = k.get("endpoint_name") or ""
            if endpoint:
                break
        except DbxError:
            pass
        time.sleep(6)
    if not endpoint:
        log.warning("knowledge assistant %s has no endpoint yet; give it access and a name from Admin once it appears", ka_id)
        return
    shaped = {
        "display_name": spec["display_name"],
        "description": spec["description"],
        "tools": [],
        "files": {},
        "access": spec["access"],
    }
    builder.finish_provisioning("", endpoint, shaped, who)


def update_assistant(ka_id: str, spec: dict, user_tok: str) -> dict:
    """Description and instructions, as the admin only. Documents are changed in
    Databricks: this screen shows them but does not rewrite them."""
    _check_id(ka_id)
    body = {"description": spec["description"], "instructions": spec["instructions"]}
    call("PATCH", KAS + "/" + ka_id, user_tok, params={"update_mask": "description,instructions"},
         json=body, headers=builder._headers())
    warnings = []
    try:
        k = call("GET", KAS + "/" + ka_id, user_tok, headers=builder._headers())
        ep = k.get("endpoint_name") or ""
        if ep:
            access.set_meta(ep, {"display_name": spec["display_name"], "blurb": spec["description"]}, app_token())
    except DbxError as exc:
        warnings.append("Saved, but the name people see could not be updated (%s)." % str(exc)[:100])
    return {"ka_id": ka_id, "warnings": warnings}


def delete_assistant(ka_id: str, user_tok: str) -> dict:
    _check_id(ka_id)
    call("DELETE", KAS + "/" + ka_id, user_tok, headers=builder._headers())
    return {"deleted": ka_id}
