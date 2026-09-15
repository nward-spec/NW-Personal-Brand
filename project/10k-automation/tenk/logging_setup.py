"""Logging. Every decision is written twice: readable, and machine-readable."""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any, Mapping


def setup(level: int = logging.INFO, log_file: Path | None = None) -> None:
    # Logs go to stderr so stdout stays clean JSON and can be piped.
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]
    if log_file is not None:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(log_file, encoding="utf-8"))
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)-7s %(name)-18s %(message)s",
        handlers=handlers,
        force=True,
    )


def log_decision(path: Path, payload: Mapping[str, Any]) -> None:
    """Append one JSON line. This is the audit trail for every morning."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, default=str, sort_keys=True) + "\n")
