"""Recent portal log lines, kept in memory so the admin panel can show them.

This is a convenience view, not an archive: it holds the last few hundred lines
of one process and empties on restart or redeploy. The durable copy is the app's
own log stream (Apps > Logs, or `databricks apps logs`).
"""
from __future__ import annotations

import logging
from collections import deque
from datetime import datetime, timezone

MAX_LINES = 500


class RingHandler(logging.Handler):
    def __init__(self, capacity: int = MAX_LINES):
        super().__init__()
        self._lines: deque = deque(maxlen=capacity)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self._lines.append(
                {
                    "at": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="seconds"),
                    "level": record.levelname,
                    "source": record.name,
                    "message": record.getMessage()
                    + (("\n" + self.formatException(record.exc_info)) if record.exc_info else ""),
                }
            )
        except Exception:  # a logging failure must never break a request
            self.handleError(record)

    def recent(self, min_level: int = logging.INFO, limit: int = 200) -> list:
        keep = [
            r for r in self._lines if logging.getLevelName(r["level"]) >= min_level
        ]
        return list(reversed(keep))[:limit]


buffer = RingHandler()
