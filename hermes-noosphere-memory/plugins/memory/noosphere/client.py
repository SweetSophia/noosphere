"""HTTP client for the Hermes Noosphere memory provider."""

from __future__ import annotations

import http.client
import ipaddress
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

_MAX_RESPONSE_BYTES = 1_000_000
_SENSITIVE_FIELD_NAMES = {
    "api_key",
    "apikey",
    "key",
    "token",
    "authorization",
    "access_token",
    "refresh_token",
}
_SENSITIVE_VALUE_RE = re.compile(
    r"(?:noo_[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:sk|pk|tok|key)_[A-Za-z0-9_-]{16,})"
)
_ALLOWED_SCHEMES = {"http", "https"}


def normalize_base_url(value: Any) -> str:
    """Return a normalized Noosphere base URL or raise for unsafe egress targets."""

    raw = str(value or "").strip()
    if not raw:
        raise ValueError("Noosphere base_url is required")
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme not in _ALLOWED_SCHEMES:
        raise ValueError("Noosphere base_url must use http or https")
    if not parsed.hostname:
        raise ValueError("Noosphere base_url must include a host")
    if parsed.username or parsed.password:
        raise ValueError("Noosphere base_url must not include credentials")

    host = parsed.hostname
    if _parse_ip_literal(host) is not None:
        try:
            ipaddress.ip_address(_normalized_host(host))
        except ValueError as error:
            raise ValueError("Noosphere base_url must use standard IP literal notation") from error
    if parsed.scheme == "http" and not _is_loopback_host(host):
        raise ValueError("Noosphere http base_url is allowed only for loopback hosts")
    if _is_blocked_network_host(host):
        raise ValueError("Noosphere base_url must not target private or reserved networks")

    netloc = host
    ip_literal = _parse_ip_literal(host)
    if (
        ip_literal is not None
        and ip_literal.version == 6
        and ":" in host
        and not host.startswith("[")
    ):
        netloc = f"[{host}]"
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("Noosphere base_url port is invalid") from error
    if port is not None:
        netloc = f"{netloc}:{port}"

    path = parsed.path.rstrip("/")
    return urllib.parse.urlunsplit((parsed.scheme, netloc, path, "", ""))


def _is_loopback_host(host: str) -> bool:
    normalized = _normalized_host(host)
    if normalized == "localhost":
        return True
    ip = _parse_ip_literal(normalized)
    return bool(ip and ip.is_loopback)


def _is_blocked_network_host(host: str) -> bool:
    ip = _parse_ip_literal(host)
    if ip is None:
        return False
    if ip.is_loopback:
        return False
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    return any(
        (
            ip.is_private,
            ip.is_link_local,
            ip.is_multicast,
            ip.is_reserved,
            ip.is_unspecified,
        )
    )


def _normalized_host(host: str) -> str:
    return host.strip().lower().strip("[]").split("%", 1)[0]


def _parse_ip_literal(host: str) -> Optional[Any]:
    normalized = _normalized_host(host)
    try:
        return ipaddress.ip_address(normalized)
    except ValueError:
        pass

    try:
        if re.fullmatch(r"(?:0x[0-9a-f]+|\d+)", normalized):
            return ipaddress.ip_address(int(normalized, 0))
        if "." in normalized and re.fullmatch(r"[0-9a-fx.]+", normalized):
            parts = normalized.split(".")
            if len(parts) == 4:
                octets = [_parse_ipv4_component(part) for part in parts]
                if all(octet is not None and 0 <= octet <= 255 for octet in octets):
                    return ipaddress.ip_address(".".join(str(octet) for octet in octets))
    except ValueError:
        return None
    return None


def _parse_ipv4_component(value: str) -> Optional[int]:
    if not value:
        return None
    if value.startswith("0x"):
        return int(value, 16)
    if len(value) > 1 and value.startswith("0"):
        return int(value, 8)
    return int(value, 10)


class NoosphereClientError(Exception):
    def __init__(self, message: str, *, status: Optional[int] = None, details: Any = None):
        super().__init__(message)
        self.status = status
        self.details = details

    def to_json(self) -> str:
        payload: Dict[str, Any] = {"error": str(self)}
        if self.status is not None:
            payload["status"] = self.status
        if self.details is not None:
            payload["details"] = self.details
        return json.dumps(payload)


class NoosphereClient:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        timeout: float,
        auto_recall_timeout: Optional[float] = None,
        status_timeout: Optional[float] = None,
    ) -> None:
        self._base_url = normalize_base_url(base_url)
        self._api_key = api_key
        self._timeout = timeout
        self._auto_recall_timeout = (
            auto_recall_timeout if auto_recall_timeout is not None else min(timeout, 4.0)
        )
        self._status_timeout = status_timeout if status_timeout is not None else min(timeout, 5.0)

    def status(self) -> Dict[str, Any]:
        try:
            return self._request_json("GET", "/api/memory/status", timeout=self._status_timeout)
        except NoosphereClientError as error:
            if error.status not in {401, 403}:
                raise
            health = self._request_json("GET", "/api/health", timeout=self._status_timeout)
            health["memoryStatusAvailable"] = False
            health["memoryStatusError"] = {
                "status": error.status,
                "error": str(error),
            }
            return health

    def recall(
        self,
        request: Dict[str, Any],
        *,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        return self._request_json("POST", "/api/memory/recall", request, timeout=timeout)

    def get(self, request: Dict[str, Any]) -> Dict[str, Any]:
        return self._request_json("POST", "/api/memory/get", request)

    def save(self, request: Dict[str, Any]) -> Dict[str, Any]:
        return self._request_json("POST", "/api/memory/save", request)

    def topics(self) -> Dict[str, Any]:
        return self._request_json("GET", "/api/topics")

    def _request_json(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        *,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        url = f"{self._base_url}{path if path.startswith('/') else '/' + path}"
        data = None
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
        }
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout or self._timeout) as response:
                return _parse_json_response(response.read(_MAX_RESPONSE_BYTES + 1))
        except urllib.error.HTTPError as error:
            details = _safe_error_body(error)
            message = _message_from_error_details(details) or f"Noosphere HTTP {error.code}"
            error.close()
            raise NoosphereClientError(message, status=error.code, details=details) from None
        except urllib.error.URLError as error:
            reason = getattr(error, "reason", None)
            if isinstance(reason, TimeoutError) or (
                isinstance(reason, str) and "timed out" in reason
            ):
                raise NoosphereClientError("Noosphere request timed out") from None
            raise NoosphereClientError(f"Noosphere request failed: {reason}") from None
        except TimeoutError:
            raise NoosphereClientError("Noosphere request timed out") from None
        except (http.client.HTTPException, OSError):
            raise NoosphereClientError("Noosphere request failed") from None


def _parse_json_response(raw: bytes) -> Dict[str, Any]:
    if len(raw) > _MAX_RESPONSE_BYTES:
        raise NoosphereClientError("Noosphere response exceeded size limit")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception as error:
        raise NoosphereClientError("Noosphere returned invalid JSON") from error
    if not isinstance(parsed, dict):
        raise NoosphereClientError("Noosphere returned non-object JSON")
    return parsed


def _safe_error_body(error: urllib.error.HTTPError) -> Any:
    try:
        raw = error.read(_MAX_RESPONSE_BYTES + 1)
    except Exception:
        return None
    if not raw or len(raw) > _MAX_RESPONSE_BYTES:
        return None
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception:
        return None
    return _redact(parsed)


def _message_from_error_details(details: Any) -> str:
    if isinstance(details, dict):
        message = details.get("error") or details.get("message")
        if isinstance(message, str):
            return message
    return ""


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: Dict[str, Any] = {}
        for key, item in value.items():
            lowered = str(key).lower()
            if (
                lowered in _SENSITIVE_FIELD_NAMES
                or lowered.endswith("_key")
                or lowered.endswith("_token")
            ):
                redacted[key] = "[redacted]"
            else:
                redacted[key] = _redact(item)
        return redacted
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, str) and _SENSITIVE_VALUE_RE.search(value):
        return "[redacted]"
    return value
