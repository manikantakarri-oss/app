"""Transport adapters - one per agent wire format.

Databricks lets people build agents in many ways (Supervisor Agent, Knowledge
Assistant, "code your own" via Agent Framework, plus raw chat models), and the
resulting endpoints do NOT speak one protocol. Verified on this workspace:

    task                  request field   response shape
    --------------------  --------------  ------------------------------------
    agent/v1/responses    input           Responses API: output[]
    agent/v1/chat         messages        ChatAgent: messages[] or choices[]
    llm/v1/chat           messages        ChatCompletions: choices[]

The formats are mutually exclusive and strictly enforced - sending `messages`
to a Responses agent returns 400 "'messages' field is not supported. Please use
'input' field instead." Agent Bricks agents also serve no OpenAPI document, so
the schema cannot be discovered up front.

So: dispatch on `task` where we know it, and where we do not, PROBE - try a
shape, read the rejection, and switch. A learned choice is remembered per
endpoint so each agent pays that cost at most once. This is what lets the portal
front an agent type that did not exist when this code was written.
"""
from __future__ import annotations

import json

# endpoint name -> request field ("input" | "messages") that worked
_learned: dict[str, str] = {}

TEXT_KEYS = ("output_text", "text", "summary_text")


# --------------------------------------------------------------------- requests


def _turns(history: list) -> list:
    return [
        {"role": m["role"], "content": m["content"]}
        for m in history
        if m.get("role") in ("user", "assistant", "system") and m.get("content")
    ]


def build(task: str, endpoint: str, history: list) -> tuple:
    """Return (payload, request_field) for this endpoint."""
    field = _learned.get(endpoint) or field_for_task(task)
    turns = _turns(history)
    if field == "input":
        return {"input": turns}, "input"
    return {"messages": turns}, "messages"


def field_for_task(task: str) -> str:
    if task == "agent/v1/responses":
        return "input"
    if task in ("agent/v1/chat", "llm/v1/chat"):
        return "messages"
    # Unknown or absent task: agents outnumber raw models in a portal, and the
    # Responses schema is the current default for Agent Bricks, so start there.
    return "input" if task.startswith("agent/") else "messages"


def other_field(field: str) -> str:
    return "messages" if field == "input" else "input"


def learn(endpoint: str, field: str) -> None:
    _learned[endpoint] = field


def wrong_field(status: int, body: str) -> bool:
    """True when a 4xx says we used the wrong request field, so a retry is worth it."""
    if status not in (400, 422):
        return False
    b = (body or "").lower()
    hints = (
        "is not supported",
        "please use 'input'",
        "please use 'messages'",
        "missing required chat parameter",
        "missing required parameter",
        "unexpected keyword",
        "field required",
    )
    return any(h in b for h in hints) and ("input" in b or "messages" in b)


# -------------------------------------------------------------------- responses


def _push(seen: list, out: list, value) -> None:
    if isinstance(value, str) and value.strip() and value not in seen:
        seen.append(value)
        out.append(value)


def _walk_content(content, text: list, seen: list, cites: list) -> None:
    """Content may be a string, or a list of typed parts (Responses / ChatAgent)."""
    if isinstance(content, str):
        _push(seen, text, content)
        return
    if not isinstance(content, list):
        return
    for part in content:
        if isinstance(part, str):
            _push(seen, text, part)
            continue
        if not isinstance(part, dict):
            continue
        for k in TEXT_KEYS:
            if part.get(k):
                _push(seen, text, part[k])
        # Knowledge Assistants attach sources as annotations on the text part.
        for ann in part.get("annotations") or []:
            if isinstance(ann, dict):
                label = ann.get("title") or ann.get("file_path") or ann.get("url")
                if label:
                    cites.append({"label": str(label), "url": ann.get("url") or ""})


def parse(data) -> dict:
    """Normalise any agent reply into {reply, tools, citations, attachments}.

    Deliberately shape-agnostic: it looks for every known carrier of assistant
    text rather than trusting the endpoint's declared task, because a "code your
    own agent" deployment can return whichever schema its author chose.
    """
    text: list = []
    seen: list = []
    tools: list = []
    cites: list = []
    files: list = []

    if isinstance(data, str):
        return {"reply": data.strip(), "tools": [], "citations": [], "attachments": []}
    if not isinstance(data, dict):
        return {"reply": "", "tools": [], "citations": [], "attachments": []}

    # 1. Responses API (agent/v1/responses)
    for item in data.get("output") or []:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind == "reasoning":
            continue
        if kind in ("function_call", "tool_call", "custom_tool_call"):
            name = item.get("name") or (item.get("function") or {}).get("name")
            if name:
                tools.append(str(name))
            continue
        _walk_content(item.get("content"), text, seen, cites)

    # 2. ChatCompletions (llm/v1/chat) and some ChatAgent deployments
    for choice in data.get("choices") or []:
        if not isinstance(choice, dict):
            continue
        msg = choice.get("message") or choice.get("delta") or {}
        _walk_content(msg.get("content"), text, seen, cites)
        for tc in msg.get("tool_calls") or []:
            name = (tc.get("function") or {}).get("name") if isinstance(tc, dict) else None
            if name:
                tools.append(str(name))

    # 3. ChatAgent returning a messages[] transcript
    for msg in data.get("messages") or []:
        if isinstance(msg, dict) and msg.get("role") in (None, "assistant"):
            _walk_content(msg.get("content"), text, seen, cites)

    # 4. Agent Bricks supervisors wrap the answer, and MLflow models use
    #    predictions. Both appear in the wild; unwrap one level.
    for key in ("final_response", "response", "answer", "result", "output_text"):
        if isinstance(data.get(key), str):
            _push(seen, text, data[key])
    preds = data.get("predictions")
    if isinstance(preds, list):
        for p in preds:
            if isinstance(p, str):
                _push(seen, text, p)
            elif isinstance(p, dict):
                inner = parse(p)
                _push(seen, text, inner["reply"])
                cites.extend(inner["citations"])
                files.extend(inner["attachments"])
    elif isinstance(preds, (str, dict)):
        inner = parse(preds) if isinstance(preds, dict) else {"reply": preds, "citations": [], "attachments": [], "tools": []}
        _push(seen, text, inner["reply"])
        cites.extend(inner["citations"])
        files.extend(inner["attachments"])

    # 5. Explicit citation / attachment carriers, wherever they hang.
    for key in ("citations", "sources", "references"):
        for c in data.get(key) or []:
            if isinstance(c, dict):
                label = c.get("title") or c.get("label") or c.get("file_path") or c.get("url")
                if label:
                    cites.append({"label": str(label), "url": c.get("url") or ""})
            elif isinstance(c, str):
                cites.append({"label": c, "url": ""})

    custom = data.get("custom_outputs")
    if isinstance(custom, dict):
        for key in ("files", "attachments", "artifacts", "generated_files"):
            for f in custom.get(key) or []:
                if isinstance(f, str):
                    files.append({"name": f.rsplit("/", 1)[-1], "path": f})
                elif isinstance(f, dict):
                    path = f.get("path") or f.get("file_path") or f.get("url") or ""
                    files.append({"name": f.get("name") or path.rsplit("/", 1)[-1], "path": path})
        inner = parse(custom)
        _push(seen, text, inner["reply"])
        cites.extend(inner["citations"])

    # de-dupe, preserving order
    tools = list(dict.fromkeys(tools))
    seen_c: set = set()
    citations = []
    for c in cites:
        k = (c["label"], c["url"])
        if k not in seen_c:
            seen_c.add(k)
            citations.append(c)

    return {
        "reply": "\n\n".join(text).strip(),
        "tools": tools,
        "citations": citations,
        "attachments": files,
    }


def parse_sse(body: str) -> dict:
    """Parse an SSE stream, accumulating deltas and raising on an error event.

    A Genie-backed agent answers `event: error` inside an HTTP 200 stream, so
    errors here are real failures, not warnings.
    """
    deltas: list = []
    final = None
    event = None
    merged = {"reply": "", "tools": [], "citations": [], "attachments": []}

    for raw in body.splitlines():
        line = raw.strip()
        if not line:
            event = None
            continue
        if line.startswith("event:"):
            event = line[6:].strip()
            continue
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload in ("[DONE]", ""):
            continue
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if event == "error" or (isinstance(data, dict) and data.get("error_code")):
            msg = data.get("message") or data.get("error") or "the agent returned an error"
            raise AgentStreamError(str(msg))
        if not isinstance(data, dict):
            continue
        dtype = str(data.get("type") or "")
        if dtype.endswith("output_text.delta") and data.get("delta"):
            deltas.append(data["delta"])
        elif dtype.endswith(".done") and data.get("text") and not deltas:
            deltas.append(data["text"])
        elif data.get("object") == "response" or "output" in data or "choices" in data:
            final = data

    if final is not None:
        merged = parse(final)
    if not merged["reply"] and deltas:
        merged["reply"] = "".join(deltas).strip()
    return merged


class AgentStreamError(RuntimeError):
    """An error event carried inside an otherwise-successful stream."""
