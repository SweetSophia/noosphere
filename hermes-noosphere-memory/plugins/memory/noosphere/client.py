"""HTTP client for the Hermes Noosphere memory provider."""

from __future__ import annotations

import http.client
import json
import re
import urllib.error
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
    def __init__(self, *, base_url: str, api_key: str, timeout: float) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout

    def status(self) -> Dict[str, Any]:
        try:
            return self._request_json("GET", "/api/memory/status")
        except NoosphereClientError as error:
            if error.status not in {401, 403}:
                raise
            health = self._request_json("GET", "/api/health")
            health["memoryStatusAvailable"] = False
            health["memoryStatusError"] = {
                "status": error.status,
                "error": str(error),
            }
            return health

    def recall(self, request: Dict[str, Any]) -> Dict[str, Any]:
        return self._request_json("POST", "/api/memory/recall", request)

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
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
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
