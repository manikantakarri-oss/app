"""Persist the portal's problem log lines to a Delta table.

Set PORTAL_LOG_TABLE to `catalog.schema.table` to turn this on; without it the
admin panel falls back to the in-memory buffer (see `logbuf`).

Design choices, all to keep logging from ever hurting the app:

* **Off the request path.** `emit` only puts a row on a queue. A background
  thread batches rows and writes them, so a slow warehouse never slows a user.
* **Problems only.** Just WARNING and above are stored. A serverless warehouse
  bills while awake, and a row per request would keep it awake all day.
* **Never loops.** The writer's own failures go to stderr, not the logger, and
  the handler ignores records raised on the writer thread.
* **Bounded.** The queue holds 1000 rows; beyond that new rows are dropped
  rather than growing memory. Rows older than RETENTION_DAYS are deleted once
  per process start.
"""
from __future__ import annotations

import logging
import os
import queue
import re
import sys
import threading
from datetime import datetime, timezone

import httpx

from dbx import DbxError, app_token, host

TABLE = os.environ.get("PORTAL_LOG_TABLE", "").strip()
WAREHOUSE = os.environ.get("PORTAL_LOG_WAREHOUSE", "").strip()
RETENTION_DAYS = 90
FLUSH_SECONDS = 10
BATCH = 25
THREAD_NAME = "log-sink"

# Identifiers cannot be bound as parameters, so the name is validated instead.
# Hyphens are allowed (catalogs like `mcp-test` exist), which is why every part
# is backtick-quoted below; the character set leaves no way to close the quote.
_TABLE_RE = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")
QUALIFIED = ".".join("`" + p + "`" for p in TABLE.split(".")) if _TABLE_RE.match(TABLE) else ""

COLUMNS = ("logged_at", "level", "source", "actor", "method", "path", "status", "message")


def enabled() -> bool:
    return bool(TABLE) and bool(_TABLE_RE.match(TABLE))


def _err(msg: str) -> None:
    print("logsink: " + msg, file=sys.stderr, flush=True)


def _run(statement: str, params: list | None = None) -> list:
    """Run one SQL statement as the app identity and return its rows."""
    tok = app_token()
    wh = WAREHOUSE or _first_warehouse(tok)
    body = {"statement": statement, "warehouse_id": wh, "wait_timeout": "30s"}
    if params:
        body["parameters"] = params
    resp = httpx.post(
        host() + "/api/2.0/sql/statements",
        headers={"Authorization": "Bearer " + tok},
        json=body,
        timeout=60,
    )
    if resp.status_code >= 400:
        raise DbxError((resp.text or "")[:300], resp.status_code)
    data = resp.json()
    status = data.get("status") or {}
    if status.get("state") in ("FAILED", "CANCELED", "CLOSED"):
        raise DbxError(str((status.get("error") or {}).get("message") or status["state"])[:300], 502)
    return (data.get("result") or {}).get("data_array") or []


def _first_warehouse(tok: str) -> str:
    resp = httpx.get(
        host() + "/api/2.0/sql/warehouses", headers={"Authorization": "Bearer " + tok}, timeout=30
    )
    if resp.status_code >= 400:
        raise DbxError("could not list warehouses: " + (resp.text or "")[:200], resp.status_code)
    whs = resp.json().get("warehouses") or []
    if not whs:
        raise DbxError("the portal can use no SQL warehouse; give its service principal CAN_USE on one", 503)
    for w in whs:
        if w.get("state") == "RUNNING":
            return w["id"]
    return whs[0]["id"]


class DeltaHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self._q: queue.Queue = queue.Queue(maxsize=1000)
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._ready = False

    def emit(self, record: logging.LogRecord) -> None:
        if threading.current_thread().name == THREAD_NAME:
            return
        try:
            row = (
                datetime.fromtimestamp(record.created, timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                record.levelname,
                record.name,
                getattr(record, "actor", None),
                getattr(record, "method", None),
                getattr(record, "path", None),
                getattr(record, "status", None),
                record.getMessage()[:4000],
            )
            self._q.put_nowait(row)
            self._start()
        except queue.Full:
            pass
        except Exception:
            self.handleError(record)

    def _start(self) -> None:
        with self._lock:
            if self._thread is None:
                self._thread = threading.Thread(target=self._loop, name=THREAD_NAME, daemon=True)
                self._thread.start()

    def _loop(self) -> None:
        while True:
            rows = [self._q.get()]
            try:
                while len(rows) < BATCH:
                    rows.append(self._q.get(timeout=FLUSH_SECONDS if len(rows) == 1 else 0.5))
            except queue.Empty:
                pass
            try:
                self._write(rows)
            except Exception as exc:  # a lost log row is better than a broken app
                _err("could not write %d row(s) to %s: %s" % (len(rows), TABLE, str(exc)[:200]))

    def _write(self, rows: list) -> None:
        if not self._ready:
            _run(
                "CREATE TABLE IF NOT EXISTS " + QUALIFIED + " ("
                "logged_at TIMESTAMP, level STRING, source STRING, actor STRING, "
                "method STRING, path STRING, status INT, message STRING)"
            )
            _run(
                "DELETE FROM " + QUALIFIED + " WHERE logged_at < current_timestamp() - INTERVAL "
                + str(RETENTION_DAYS) + " DAYS"
            )
            self._ready = True

        params, tuples = [], []
        for i, row in enumerate(rows):
            marks = []
            for col, val in zip(COLUMNS, row):
                name = f"{col}{i}"
                p = {"name": name, "type": "INT" if col == "status" else "STRING"}
                if val is not None:
                    p["value"] = str(val)
                params.append(p)
                marks.append(f"CAST(:{name} AS TIMESTAMP)" if col == "logged_at" else ":" + name)
            tuples.append("(" + ", ".join(marks) + ")")
        _run("INSERT INTO " + QUALIFIED + " VALUES " + ", ".join(tuples), params)


def recent(days: int, limit: int) -> list:
    """Stored problem lines, newest first, in the same shape as `logbuf`."""
    days = 1 if days < 1 else (90 if days > 90 else days)
    rows = _run(
        "SELECT date_format(logged_at, \"yyyy-MM-dd'T'HH:mm:ss'Z'\"), level, source, message "
        "FROM " + QUALIFIED + " WHERE logged_at >= current_timestamp() - INTERVAL " + str(days) + " DAYS "
        "ORDER BY logged_at DESC LIMIT " + str(int(limit))
    )
    return [{"at": r[0], "level": r[1], "source": r[2], "message": r[3]} for r in rows]


handler = DeltaHandler()
