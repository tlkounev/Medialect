from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

log = logging.getLogger("medialect")

USER_AGENT = "Medialect/0.1 (+self-hosted)"


@dataclass
class SyncContext:
    source: str
    settings: dict[str, Any]
    started: float = field(default_factory=time.time)
    items: int = 0
    notes: list[str] = field(default_factory=list)
    partial: bool = False
    phase: str = ""

    def progress(self, phase: str) -> None:
        """Human readable description of what the job is doing right now (shown live in the UI)."""
        self.phase = phase

    def note(self, msg: str) -> None:
        log.info("[%s] %s", self.source, msg)
        self.notes.append(msg)


class SourceError(Exception):
    pass


def http_client(**kw) -> httpx.AsyncClient:
    headers = {"User-Agent": USER_AGENT, **kw.pop("headers", {})}
    return httpx.AsyncClient(timeout=kw.pop("timeout", 30), headers=headers, follow_redirects=True, **kw)
