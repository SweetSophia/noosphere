from __future__ import annotations

import importlib.util
import http.client
import json
import sys
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock


PLUGIN_DIR = (
    Path(__file__).resolve().parents[1]
    / "plugins"
    / "memory"
    / "noosphere"
)


class _FakeMemoryProvider:
    pass


def load_plugin_package():
    agent_module = types.ModuleType("agent")
    memory_provider_module = types.ModuleType("agent.memory_provider")
    memory_provider_module.MemoryProvider = _FakeMemoryProvider
    with mock.patch.dict(
        sys.modules,
        {
            "agent": agent_module,
            "agent.memory_provider": memory_provider_module,
        },
    ):
        spec = importlib.util.spec_from_file_location(
            "noosphere_memory_plugin",
            PLUGIN_DIR / "__init__.py",
            submodule_search_locations=[str(PLUGIN_DIR)],
        )
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        with mock.patch.dict(sys.modules, {"noosphere_memory_plugin": module}):
            spec.loader.exec_module(module)
            return module


class _StatusHandler(BaseHTTPRequestHandler):
    response_status = 200
    response_body = {"ok": True, "providers": [], "settings": {}}
    seen_authorization = ""
    seen_json = {}

    def do_GET(self):
        if self.path != "/api/memory/status":
            self.send_response(404)
            self.end_headers()
            return
        type(self).seen_authorization = self.headers.get("Authorization", "")
        raw = json.dumps(type(self).response_body).encode("utf-8")
        self.send_response(type(self).response_status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        if self.path not in {"/api/memory/recall", "/api/memory/get"}:
            self.send_response(404)
            self.end_headers()
            return
        type(self).seen_authorization = self.headers.get("Authorization", "")
        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length)
        type(self).seen_json = json.loads(raw_body.decode("utf-8")) if raw_body else {}
        raw = json.dumps(type(self).response_body).encode("utf-8")
        self.send_response(type(self).response_status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, format, *args):
        return


class NoosphereClientTest(unittest.TestCase):
    def setUp(self):
        _StatusHandler.response_status = 200
        _StatusHandler.response_body = {"ok": True, "providers": [], "settings": {}}
        _StatusHandler.seen_authorization = ""
        _StatusHandler.seen_json = {}
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _StatusHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()

    def test_status_sends_bearer_key_and_returns_json(self):
        module = load_plugin_package()
        client = module.NoosphereClient(
            base_url=self.base_url,
            api_key="noo_test",
            timeout=2.0,
        )

        result = client.status()

        self.assertTrue(result["ok"])
        self.assertEqual(_StatusHandler.seen_authorization, "Bearer noo_test")

    def test_recall_posts_json_body(self):
        module = load_plugin_package()
        _StatusHandler.response_body = {"results": [], "mode": "inspection"}
        client = module.NoosphereClient(
            base_url=self.base_url,
            api_key="noo_test",
            timeout=2.0,
        )

        result = client.recall({"query": "deploy", "mode": "inspection"})

        self.assertEqual(result["mode"], "inspection")
        self.assertEqual(_StatusHandler.seen_authorization, "Bearer noo_test")
        self.assertEqual(_StatusHandler.seen_json["query"], "deploy")

    def test_http_error_is_redacted_json(self):
        module = load_plugin_package()
        _StatusHandler.response_status = 401
        _StatusHandler.response_body = {
            "error": "Unauthorized",
            "apiKey": "noo_secret",
            "nested": {"authorization": "Bearer noo_secret"},
        }
        client = module.NoosphereClient(
            base_url=self.base_url,
            api_key="noo_secret",
            timeout=2.0,
        )

        with self.assertRaises(module.NoosphereClientError) as caught:
            client.status()

        payload = json.loads(caught.exception.to_json())
        self.assertEqual(payload["status"], 401)
        self.assertEqual(payload["details"]["apiKey"], "[redacted]")
        self.assertEqual(payload["details"]["nested"]["authorization"], "[redacted]")

    def test_http_exception_is_wrapped(self):
        module = load_plugin_package()
        client = module.NoosphereClient(
            base_url=self.base_url,
            api_key="noo_test",
            timeout=2.0,
        )

        client_globals = module.NoosphereClient._request_json.__globals__
        with mock.patch.object(
            client_globals["urllib"].request,
            "urlopen",
            side_effect=http.client.HTTPException("bad status line"),
        ):
            with self.assertRaises(module.NoosphereClientError) as caught:
                client.status()

        self.assertEqual(str(caught.exception), "Noosphere request failed")

    def test_redact_preserves_non_secret_key_substrings(self):
        module = load_plugin_package()

        redacted = module.NoosphereClient._request_json.__globals__["_redact"](
            {
                "monkey": "visible",
                "keywords": ["search", "terms"],
                "access_token": "tok_1234567890abcdef",
                "message": "Bearer secretbearertoken",
            }
        )

        self.assertEqual(redacted["monkey"], "visible")
        self.assertEqual(redacted["keywords"], ["search", "terms"])
        self.assertEqual(redacted["access_token"], "[redacted]")
        self.assertEqual(redacted["message"], "[redacted]")


if __name__ == "__main__":
    unittest.main()
