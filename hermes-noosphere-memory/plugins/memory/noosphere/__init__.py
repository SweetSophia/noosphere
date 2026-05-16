"""Noosphere memory provider for Hermes Agent.

Phase 1 implements provider discovery, setup schema, config persistence, and
safe lifecycle initialization. HTTP tools and recall hooks are added in later
phases.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

from .client import NoosphereClient, NoosphereClientError
from .formatting import strip_context_fences
from .schemas import TOOL_SCHEMAS

logger = logging.getLogger(__name__)

_CONFIG_FILENAME = "noosphere.json"
_DEFAULT_CONFIG: Dict[str, Any] = {
    "base_url": "http://127.0.0.1:6578",
    "auto_recall": True,
    "auto_capture": False,
    "capture_mode": "explicit",
    "max_recall_results": 5,
    "token_budget": 1200,
    "topic_id": "",
    "author_name_template": "Hermes:{identity}",
    "api_timeout": 5.0,
}
_NON_WRITING_CONTEXTS = {"cron", "flush", "subagent"}
_SECRET_CONFIG_KEYS = {"api_key"}
_MIN_CAPTURE_LENGTH = 40  # Noosphere API durable content minimum
_TRIVIAL_RE = re.compile(
    r"^(ok|okay|thanks|thank you|got it|sure|yes|no|yep|nope|k|ty|thx|np)\.?$",
    re.IGNORECASE,
)


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
        self._client: Optional[NoosphereClient] = None
        self._write_thread: Optional[threading.Thread] = None

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
        self._client = None
        if self._active:
            self._client = NoosphereClient(
                base_url=str(self._config["base_url"]),
                api_key=self._api_key,
                timeout=float(self._config["api_timeout"]),
            )

    def system_prompt_block(self) -> str:
        if not self._active:
            return ""
        return (
            "# Noosphere\n"
            "Noosphere memory provider is configured. Use noosphere_recall, "
            "noosphere_get, noosphere_topics, and noosphere_status for explicit "
            "memory operations. Save only durable, reusable knowledge; skip "
            "transient task status and trivial turns."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not self._active or not self._client or not self._config.get("auto_recall"):
            return ""
        if not query or not query.strip():
            return ""
        try:
            result = self._client.recall(
                {
                    "query": query.strip()[:1000],
                    "mode": "auto",
                    "resultCap": self._config["max_recall_results"],
                    "tokenBudget": self._config["token_budget"],
                }
            )
        except NoosphereClientError:
            logger.debug("Noosphere prefetch failed", exc_info=True)
            return ""
        prompt_text = result.get("promptInjectionText")
        return strip_context_fences(prompt_text) if isinstance(prompt_text, str) else ""

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return TOOL_SCHEMAS

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs: Any) -> str:
        if not self._active or not self._client:
            return json.dumps({"error": "Noosphere is not configured. Set NOOSPHERE_API_KEY."})

        try:
            if tool_name == "noosphere_status":
                return json.dumps(self._client.status())
            if tool_name == "noosphere_topics":
                return json.dumps(self._client.topics())
            if tool_name == "noosphere_recall":
                return json.dumps(self._client.recall(_read_recall_args(args, self._config)))
            if tool_name == "noosphere_get":
                return json.dumps(self._client.get(_read_get_args(args)))
            if tool_name == "noosphere_save":
                if not self._write_enabled:
                    return json.dumps({"error": "Write operations are disabled in the current context (cron/flush/subagent)."})
                return json.dumps(
                    self._client.save(_read_save_args(args, self._config, self._agent_identity))
                )
            return json.dumps({"error": f"Unknown Noosphere memory tool: {tool_name}"})
        except (NoosphereClientError, ValueError) as error:
            if isinstance(error, ValueError):
                return json.dumps({"error": str(error)})
            return error.to_json()

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        if not self._active or not self._client or not self._write_enabled:
            return
        if not self._config.get("auto_capture") or not self._config.get("topic_id"):
            return
        clean_user = _clean_capture_text(user_content)
        clean_assistant = _clean_capture_text(assistant_content)
        if not _should_capture(clean_user) or not _should_capture(clean_assistant):
            return
        title = _truncate_title(f"Hermes turn: {clean_user}", 120)
        content = (
            f"[role: user]\n{clean_user}\n[user:end]\n\n"
            f"[role: assistant]\n{clean_assistant}\n[assistant:end]"
        )
        self._save_async(
            {
                "title": title,
                "content": content,
                "topicId": self._config["topic_id"],
                "source": f"hermes:session:{session_id or self._session_id}",
                "authorName": _resolve_author_name(self._config, self._agent_identity),
                "confidence": "medium",
                "tags": ["hermes", "conversation-turn"],
            }
        )

    def on_memory_write(
        self,
        action: str,
        target: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        if action != "add" or not self._active or not self._client or not self._write_enabled:
            return
        clean = _clean_capture_text(content)
        if not _should_capture(clean) or not self._config.get("topic_id"):
            return
        self._save_async(
            {
                "title": _truncate_title(f"Hermes memory: {target}", 120),
                "content": clean,
                "topicId": self._config["topic_id"],
                "source": str((metadata or {}).get("source") or f"hermes:memory:{target}"),
                "authorName": _resolve_author_name(self._config, self._agent_identity),
                "confidence": "medium",
                "tags": ["hermes", "explicit-memory", target],
            }
        )

    def _save_async(self, request: Dict[str, Any]) -> None:
        if not self._client:
            return

        def _run() -> None:
            try:
                assert self._client is not None
                self._client.save(request)
            except Exception:
                logger.debug("Noosphere async save failed", exc_info=True)

        if self._write_thread and self._write_thread.is_alive():
            self._write_thread.join(timeout=2.0)
        self._write_thread = threading.Thread(target=_run, daemon=True, name="noosphere-save")
        self._write_thread.start()

    def shutdown(self) -> None:
        if self._write_thread and self._write_thread.is_alive():
            self._write_thread.join(timeout=5.0)
        return None


def register(ctx: Any) -> None:
    """Register the Noosphere memory provider with Hermes."""

    ctx.register_memory_provider(NoosphereMemoryProvider())


def _read_recall_args(args: Dict[str, Any], config: Dict[str, Any]) -> Dict[str, Any]:
    query = _as_string(args.get("query"))
    if not query:
        raise ValueError("query is required")
    request: Dict[str, Any] = {
        "query": query[:1000],  # Noosphere API limits query to 1000 chars
        "mode": "inspection",
        "resultCap": _as_int(
            args.get("resultCap"),
            int(config["max_recall_results"]),
            minimum=1,
            maximum=20,
        ),
        "tokenBudget": _as_int(
            args.get("tokenBudget"),
            int(config["token_budget"]),
            minimum=100,
            maximum=8000,
        ),
    }
    scope = _as_string(args.get("scope"))
    if scope:
        request["scope"] = scope
    return request


def _read_get_args(args: Dict[str, Any]) -> Dict[str, Any]:
    canonical_ref = _as_string(args.get("canonicalRef"))
    provider = _as_string(args.get("provider"))
    memory_id = _as_string(args.get("id"))
    if canonical_ref:
        if provider or memory_id:
            raise ValueError("Use either canonicalRef or provider+id, not both")
        return {"canonicalRef": canonical_ref}
    if provider and memory_id:
        return {"provider": provider, "id": memory_id}
    raise ValueError("Provide canonicalRef or provider+id")


def _read_save_args(
    args: Dict[str, Any],
    config: Dict[str, Any],
    agent_identity: str,
) -> Dict[str, Any]:
    title = _as_string(args.get("title"))
    content = _clean_capture_text(args.get("content", ""))
    topic_id = _as_string(args.get("topicId")) or _as_string(config.get("topic_id"))
    if not title:
        raise ValueError("title is required")
    if not content:
        raise ValueError("content is required")
    if not topic_id:
        raise ValueError("topicId is required unless noosphere.json defines topic_id")

    request: Dict[str, Any] = {
        "title": _truncate_title(title, 160),
        "content": content,
        "topicId": topic_id,
        "authorName": _resolve_author_name(config, agent_identity),
    }
    for key in ("excerpt", "source", "confidence"):
        value = _as_string(args.get(key))
        if value:
            request[key] = value
    tags = args.get("tags")
    if isinstance(tags, list):
        clean_tags = [_as_string(tag) for tag in tags]
        clean_tags = [tag for tag in clean_tags if tag]
        if clean_tags:
            request["tags"] = clean_tags[:20]
    return request


def _clean_capture_text(text: Any) -> str:
    return strip_context_fences(str(text or "")).strip()


def _should_capture(text: str) -> bool:
    return len(text) >= _MIN_CAPTURE_LENGTH and not _TRIVIAL_RE.match(text)


def _truncate_title(text: str, limit: int) -> str:
    clean = " ".join((text or "").split())
    if len(clean) <= limit:
        return clean
    return clean[: limit - 3].rstrip() + "..."


def _resolve_author_name(config: Dict[str, Any], agent_identity: str) -> str:
    template = _as_string(config.get("author_name_template"), "Hermes:{identity}")
    return template.replace("{identity}", agent_identity or "default")
