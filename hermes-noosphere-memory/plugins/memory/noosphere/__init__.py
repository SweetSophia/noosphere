"""Noosphere memory provider for Hermes Agent.

Phase 1 implements provider discovery, setup schema, config persistence, and
safe lifecycle initialization. HTTP tools and recall hooks are added in later
phases.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

_CONFIG_FILENAME = "noosphere.json"
_DEFAULT_CONFIG: Dict[str, Any] = {
    "base_url": "http://127.0.0.1:6578",
    "auto_recall": True,
    "auto_capture": False,
    "capture_mode": "explicit",
    "max_recall_results": 5,
    "token_budget": 1200,
    "providers": ["noosphere"],
    "topic_id": "",
    "author_name_template": "Hermes:{identity}",
    "api_timeout": 5.0,
}
_NON_WRITING_CONTEXTS = {"cron", "flush", "subagent"}
_SECRET_CONFIG_KEYS = {"api_key"}


def _config_path(hermes_home: str) -> Path:
    return Path(hermes_home).expanduser() / _CONFIG_FILENAME


def _setup_key_url() -> str:
    base_url = os.environ.get("NOOSPHERE_BASE_URL", _DEFAULT_CONFIG["base_url"])
    base_url = _as_string(base_url, _DEFAULT_CONFIG["base_url"]).rstrip("/")
    return f"{base_url}/wiki/admin/keys"


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "y", "on"}:
            return True
        if lowered in {"false", "0", "no", "n", "off"}:
            return False
    return default


def _as_int(value: Any, default: int, *, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def _as_float(value: Any, default: float, *, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def _as_string(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value).strip()


def _as_provider_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return list(_DEFAULT_CONFIG["providers"])
    providers = []
    for item in value:
        provider = _as_string(item)
        if provider and provider not in providers:
            providers.append(provider)
    return providers or list(_DEFAULT_CONFIG["providers"])


def _sanitize_config(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize config loaded from Hermes setup or noosphere.json."""

    config = dict(_DEFAULT_CONFIG)
    config.update({key: value for key, value in raw.items() if value is not None})

    base_url = _as_string(config.get("base_url"), _DEFAULT_CONFIG["base_url"]).rstrip("/")
    config["base_url"] = base_url or _DEFAULT_CONFIG["base_url"]
    config["auto_recall"] = _as_bool(config.get("auto_recall"), True)
    config["auto_capture"] = _as_bool(config.get("auto_capture"), False)

    capture_mode = _as_string(config.get("capture_mode"), "explicit").lower()
    config["capture_mode"] = capture_mode if capture_mode in {"explicit", "all"} else "explicit"

    config["max_recall_results"] = _as_int(
        config.get("max_recall_results"),
        int(_DEFAULT_CONFIG["max_recall_results"]),
        minimum=1,
        maximum=20,
    )
    config["token_budget"] = _as_int(
        config.get("token_budget"),
        int(_DEFAULT_CONFIG["token_budget"]),
        minimum=100,
        maximum=8000,
    )
    config["providers"] = _as_provider_list(config.get("providers"))
    config["topic_id"] = _as_string(config.get("topic_id"))
    config["author_name_template"] = _as_string(
        config.get("author_name_template"),
        _DEFAULT_CONFIG["author_name_template"],
    )
    config["api_timeout"] = _as_float(
        config.get("api_timeout"),
        float(_DEFAULT_CONFIG["api_timeout"]),
        minimum=0.5,
        maximum=30.0,
    )
    return config


def _load_noosphere_config(hermes_home: str) -> Dict[str, Any]:
    path = _config_path(hermes_home)
    if not path.exists():
        return dict(_DEFAULT_CONFIG)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("Failed to parse %s; using defaults", path, exc_info=True)
        return dict(_DEFAULT_CONFIG)
    if not isinstance(raw, dict):
        logger.warning("Ignoring non-object Noosphere config at %s", path)
        return dict(_DEFAULT_CONFIG)
    return _sanitize_config(raw)


def _save_noosphere_config(values: Dict[str, Any], hermes_home: str) -> None:
    path = _config_path(hermes_home)
    existing: Dict[str, Any] = {}
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                existing = raw
        except Exception:
            logger.warning(
                "Failed to parse existing Noosphere config at %s; ignoring",
                path,
                exc_info=True,
            )
            existing = {}

    sanitized_values = dict(values or {})
    for key in _SECRET_CONFIG_KEYS:
        existing.pop(key, None)
        sanitized_values.pop(key, None)
    existing.update(sanitized_values)
    config = _sanitize_config(existing)

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as tmp:
            json.dump(config, tmp, indent=2, sort_keys=True)
            tmp.write("\n")
            tmp.flush()
            os.fsync(tmp.fileno())
        try:
            os.chmod(tmp_name, 0o600)
        except OSError:
            logger.debug("Could not chmod temporary config %s", tmp_name, exc_info=True)
        os.replace(tmp_name, path)
    finally:
        try:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)
        except OSError:
            logger.debug("Could not remove temporary config %s", tmp_name, exc_info=True)
    try:
        path.chmod(0o600)
    except OSError:
        logger.debug("Could not chmod %s", path, exc_info=True)


class NoosphereMemoryProvider(MemoryProvider):
    def __init__(self) -> None:
        self._config: Dict[str, Any] = dict(_DEFAULT_CONFIG)
        self._api_key = ""
        self._session_id = ""
        self._hermes_home = ""
        self._platform = ""
        self._agent_identity = "default"
        self._agent_context = ""
        self._write_enabled = True
        self._active = False

    @property
    def name(self) -> str:
        return "noosphere"

    def is_available(self) -> bool:
        return bool(os.environ.get("NOOSPHERE_API_KEY", "").strip())

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "api_key",
                "description": "Noosphere API key",
                "secret": True,
                "required": True,
                "env_var": "NOOSPHERE_API_KEY",
                "url": _setup_key_url(),
            },
            {
                "key": "base_url",
                "description": "Noosphere base URL",
                "required": True,
                "default": _DEFAULT_CONFIG["base_url"],
            },
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        _save_noosphere_config(values, hermes_home)

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._session_id = session_id
        self._hermes_home = (
            kwargs.get("hermes_home")
            or os.environ.get("HERMES_HOME")
            or str(Path.home() / ".hermes")
        )
        self._platform = _as_string(kwargs.get("platform"))
        self._agent_identity = _as_string(kwargs.get("agent_identity"), "default") or "default"
        self._agent_context = _as_string(kwargs.get("agent_context"))

        self._config = _load_noosphere_config(self._hermes_home)
        env_base_url = os.environ.get("NOOSPHERE_BASE_URL", "").strip().rstrip("/")
        if env_base_url:
            self._config["base_url"] = env_base_url

        self._api_key = os.environ.get("NOOSPHERE_API_KEY", "").strip()
        self._write_enabled = self._agent_context not in _NON_WRITING_CONTEXTS
        self._active = bool(self._api_key)

    def system_prompt_block(self) -> str:
        if not self._active:
            return ""
        return (
            "# Noosphere\n"
            "Noosphere memory provider is configured. Explicit memory tools and "
            "automatic recall are added by later plugin phases. Save only durable, "
            "reusable knowledge; skip transient task status and trivial turns."
        )

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return []

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs: Any) -> str:
        logger.warning("Noosphere memory tool called before Phase 2 implementation: %s", tool_name)
        return json.dumps(
            {
                "error": "Noosphere memory tools are not implemented in Phase 1.",
                "tool": tool_name,
            }
        )

    def shutdown(self) -> None:
        return None


def register(ctx: Any) -> None:
    """Register the Noosphere memory provider with Hermes."""

    ctx.register_memory_provider(NoosphereMemoryProvider())
