"""Adapter tests - one case per agent shape the portal must front.

Run: python test_adapters.py    (no pytest needed, no workspace needed)

The Responses and ChatCompletions cases are real payloads captured from this
workspace. The rest are the documented shapes for agent types that are not
deployed here yet, so the portal is proven to handle them before one appears.
"""
from __future__ import annotations

import adapters

CASES = []


def case(name):
    def deco(fn):
        CASES.append((name, fn))
        return fn

    return deco


# ---------------------------------------------------------------- real payloads


@case("supervisor agent (agent/v1/responses) - captured from this workspace")
def _():
    data = {
        "object": "response",
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "Hello from your weather agent."}],
            }
        ],
        "custom_outputs": None,
    }
    out = adapters.parse(data)
    assert out["reply"] == "Hello from your weather agent.", out
    assert out["tools"] == []


@case("chat model (llm/v1/chat) - captured from this workspace")
def _():
    data = {
        "choices": [
            {"message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}
        ]
    }
    assert adapters.parse(data)["reply"] == "OK"


@case("responses agent with tool calls reports the tools used")
def _():
    data = {
        "output": [
            {"type": "function_call", "name": "sandbox"},
            {"type": "reasoning", "content": [{"type": "text", "text": "ignore me"}]},
            {"type": "function_call", "name": "sandbox"},
            {"type": "message", "content": [{"type": "output_text", "text": "Done."}]},
        ]
    }
    out = adapters.parse(data)
    assert out["reply"] == "Done.", out
    assert out["tools"] == ["sandbox"], out  # de-duplicated


# ------------------------------------------------------- shapes not yet deployed


@case("ChatAgent (agent/v1/chat) returning a messages transcript")
def _():
    data = {"messages": [{"role": "assistant", "content": "Answer from a ChatAgent."}]}
    assert adapters.parse(data)["reply"] == "Answer from a ChatAgent."


@case("Knowledge Assistant - citations arrive as text annotations")
def _():
    data = {
        "output": [
            {
                "type": "message",
                "content": [
                    {
                        "type": "output_text",
                        "text": "Staff get 25 days of leave.",
                        "annotations": [
                            {"title": "Leave Policy 2026", "url": "https://x/leave.pdf"}
                        ],
                    }
                ],
            }
        ]
    }
    out = adapters.parse(data)
    assert out["reply"] == "Staff get 25 days of leave."
    assert out["citations"] == [{"label": "Leave Policy 2026", "url": "https://x/leave.pdf"}], out


@case("Knowledge Assistant - citations as a top-level sources list")
def _():
    data = {"choices": [{"message": {"content": "See the handbook."}}],
            "sources": [{"title": "Handbook", "url": "https://x/h.pdf"}, "Policy A"]}
    out = adapters.parse(data)
    labels = [c["label"] for c in out["citations"]]
    assert labels == ["Handbook", "Policy A"], out


@case("Agent Bricks supervisor wrapping its answer in final_response")
def _():
    # This is the real shape the mid-campaign agent returns.
    data = {"final_response": "Please upload your campaign Excel file (.xlsx)."}
    assert adapters.parse(data)["reply"].startswith("Please upload"), adapters.parse(data)


@case("file-producing agent - attachment surfaces from custom_outputs")
def _():
    data = {
        "output": [{"type": "message", "content": [{"type": "output_text", "text": "Report ready."}]}],
        "custom_outputs": {
            "files": [{"name": "report.pptx", "path": "/Volumes/c/s/v/report.pptx"}]
        },
    }
    out = adapters.parse(data)
    assert out["reply"] == "Report ready."
    assert out["attachments"] == [{"name": "report.pptx", "path": "/Volumes/c/s/v/report.pptx"}], out


@case("legacy MLflow model returning predictions")
def _():
    assert adapters.parse({"predictions": ["legacy answer"]})["reply"] == "legacy answer"


@case("custom agent returning a bare string")
def _():
    assert adapters.parse("just text")["reply"] == "just text"


@case("classification-style agent returning a structured result")
def _():
    # ai_classify-shaped output: no chat wrapper at all.
    assert adapters.parse({"result": "billing"})["reply"] == "billing"


# ----------------------------------------------------------------------- streams


@case("SSE deltas are stitched together")
def _():
    body = (
        'data: {"type":"response.output_text.delta","delta":"Hel"}\n\n'
        'data: {"type":"response.output_text.delta","delta":"lo"}\n\n'
        "data: [DONE]\n"
    )
    assert adapters.parse_sse(body)["reply"] == "Hello"


@case("SSE final response object wins over deltas")
def _():
    body = (
        'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
        'data: {"object":"response","output":[{"type":"message","content":'
        '[{"type":"output_text","text":"final answer"}]}]}\n\n'
        "data: [DONE]\n"
    )
    assert adapters.parse_sse(body)["reply"] == "final answer"


@case("SSE error inside HTTP 200 raises instead of returning blank")
def _():
    # The real trap: this workspace's Genie agent answers exactly like this.
    body = (
        "event: error\n"
        'data: {"error_code":"INVALID_PARAMETER_VALUE","message":"Error getting permissions"}\n\n'
        "data: [DONE]\n"
    )
    try:
        adapters.parse_sse(body)
    except adapters.AgentStreamError as exc:
        assert "Error getting permissions" in str(exc)
        return
    raise AssertionError("expected AgentStreamError")


# ------------------------------------------------------------- request selection


@case("request field is chosen from the task")
def _():
    assert adapters.field_for_task("agent/v1/responses") == "input"
    assert adapters.field_for_task("agent/v1/chat") == "messages"
    assert adapters.field_for_task("llm/v1/chat") == "messages"
    # An agent task invented after this code was written still gets a sane guess.
    assert adapters.field_for_task("agent/v9/something") == "input"
    assert adapters.field_for_task("") == "messages"


@case("a wrong-field rejection is recognised and remembered")
def _():
    body = (
        '{"error_code":"INVALID_PARAMETER_VALUE","message":"Invalid request: '
        "'messages' field is not supported. Please use 'input' field instead.\"}"
    )
    assert adapters.wrong_field(400, body) is True
    assert adapters.wrong_field(400, '{"message":"Missing required Chat parameter: \'messages\'"}')
    # MLflow's own schema-enforcement phrasing for a ChatAgent-interface model.
    mlflow_body = (
        "Failed to enforce schema of data '{'input': [{'role': 'user', "
        "'content': 'hi'}]}' with schema '['messages': Array(...) (required)...'. "
        "Error: Model is missing inputs ['messages']. Note that there were "
        "extra inputs: ['input']."
    )
    assert adapters.wrong_field(400, mlflow_body) is True
    # Unrelated failures must not trigger a pointless retry.
    assert adapters.wrong_field(400, '{"message":"rate limited"}') is False
    assert adapters.wrong_field(403, "forbidden") is False

    adapters.learn("ep-1", "messages")
    payload, field = adapters.build("agent/v1/responses", "ep-1", [{"role": "user", "content": "x"}])
    assert field == "messages" and "messages" in payload, (payload, field)


@case("system and assistant turns survive; empty turns are dropped")
def _():
    hist = [
        {"role": "system", "content": "be brief"},
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": ""},
        {"role": "tool", "content": "noise"},
    ]
    payload, _ = adapters.build("agent/v1/responses", "ep-fresh", hist)
    assert [m["role"] for m in payload["input"]] == ["system", "user"], payload


def main() -> int:
    passed = failed = 0
    for name, fn in CASES:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 - test harness
            print("  FAIL  " + name)
            print("        " + type(exc).__name__ + ": " + str(exc)[:220])
            failed += 1
        else:
            print("  PASS  " + name)
            passed += 1
    print("--- %d passed, %d failed ---" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
