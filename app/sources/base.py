from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

log = logging.getLogger("medialect")

USER_AGENT = f"Medialect/{os.environ.get('APP_VERSION', 'dev')} (+self-hosted)"


@dataclass
class SyncContext:
    source: str
    settings: dict[str, Any]
    started: float = field(default_factory=time.time)
    items: int = 0
    notes: list[str] = field(default_factory=list)
    partial: bool = False
    phase: str = ""
    percent: int | None = None
    _span: tuple[float, float] = (0.0, 1.0)

    def step(self, i: int, n: int) -> None:
        """The job runs n consecutive steps; fractions reported from now on belong to step i (0-based)."""
        self._span = (i / n, (i + 1) / n)
        self.percent = int(self._span[0] * 100)

    def progress(self, phase: str, fraction: float | None = None) -> None:
        """Human readable description of what the job is doing right now (shown live in the UI).

        fraction (0–1) is the estimated share of the job already done; None keeps the last value."""
        self.phase = phase
        if fraction is not None:
            lo, hi = self._span
            self.percent = max(0, min(99, int((lo + fraction * (hi - lo)) * 100)))

    def note(self, msg: str) -> None:
        log.info("[%s] %s", self.source, msg)
        self.notes.append(msg)


class SourceError(Exception):
    pass


def http_client(**kw) -> httpx.AsyncClient:
    headers = {"User-Agent": USER_AGENT, **kw.pop("headers", {})}
    return httpx.AsyncClient(timeout=kw.pop("timeout", 30), headers=headers, follow_redirects=True, **kw)
