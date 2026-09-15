"""Runtime configuration. Files hold settings; the environment holds secrets."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

import yaml

ENV_WHOOP_CLIENT_ID = "WHOOP_CLIENT_ID"
ENV_WHOOP_CLIENT_SECRET = "WHOOP_CLIENT_SECRET"
ENV_INTERVALS_KEY = "INTERVALS_ICU_API_KEY"
ENV_SMTP_PASSWORD = "SMTP_PASSWORD"


class ConfigError(RuntimeError):
    pass


@dataclass
class Config:
    root: Path
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Optional[str] = None) -> "Config":
        root = Path(__file__).resolve().parent.parent
        config_path = Path(path) if path else root / "config" / "config.yaml"
        if not config_path.exists():
            example = root / "config" / "config.example.yaml"
            raise ConfigError(
                f"No config at {config_path}. Copy {example} to {config_path} and fill it in."
            )
        with open(config_path, "r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh) or {}
        return cls(root=root, raw=raw)

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any], *, root: Optional[Path] = None) -> "Config":
        """In-memory config, for the selftest and the test suite."""
        return cls(root=root or Path(__file__).resolve().parent.parent, raw=dict(raw))

    # ------------------------------------------------------------------ paths

    def path(self, value: str) -> Path:
        candidate = Path(value)
        return candidate if candidate.is_absolute() else self.root / candidate

    @property
    def plan_file(self) -> Path:
        return self.path(self.raw.get("plan_file", "config/plan.yaml"))

    @property
    def state_dir(self) -> Path:
        directory = self.path(self.raw.get("state_dir", "state"))
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    @property
    def token_file(self) -> Path:
        return self.state_dir / "whoop_tokens.json"

    @property
    def run_state_file(self) -> Path:
        return self.state_dir / "run_state.json"

    @property
    def decision_log(self) -> Path:
        return self.state_dir / "decisions.jsonl"

    @property
    def outbox(self) -> Path:
        box = self.state_dir / "outbox"
        box.mkdir(parents=True, exist_ok=True)
        return box

    # --------------------------------------------------------------- sections

    def section(self, name: str) -> Dict[str, Any]:
        value = self.raw.get(name) or {}
        if not isinstance(value, Mapping):
            raise ConfigError(f"config section {name!r} must be a mapping")
        return dict(value)

    @property
    def engine(self) -> Dict[str, Any]:
        return self.section("engine")

    @property
    def whoop(self) -> Dict[str, Any]:
        return self.section("whoop")

    @property
    def intervals(self) -> Dict[str, Any]:
        return self.section("intervals_icu")

    @property
    def calendar(self) -> Dict[str, Any]:
        return self.section("google_calendar")

    @property
    def summary(self) -> Dict[str, Any]:
        return self.section("summary")

    # ---------------------------------------------------------------- secrets

    @staticmethod
    def secret(name: str, *, required: bool = True) -> str:
        value = os.environ.get(name, "").strip()
        if not value and required:
            raise ConfigError(
                f"{name} is not set. Secrets come from the environment, never from a file in the repo."
            )
        return value
