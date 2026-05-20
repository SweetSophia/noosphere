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
    health_body = {"status": "ok"}
    seen_authorization = ""
    seen_json = {}

    def do_GET(self):
        if self.path == "/api/health":
            raw = json.dumps(type(self).health_body).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
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


class _JsonResponse:
    def __init__(self, body):
        self.body = json.dumps(body).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self, size=-1):
        return self.body


class NoosphereClientTest(unittest.TestCase):
    def setUp(self):
        _StatusHandler.response_status = 200
        _StatusHandler.response_body = {"ok": True, "providers": [], "settings": {}}
        _StatusHandler.health_body = {"status": "ok"}
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

    def test_status_falls_back_to_health_for_scoped_key(self):
        module = load_plugin_package()
        _StatusHandler.response_status = 403
        _StatusHandler.response_body = {"error": "Insufficient permissions"}
        _StatusHandler.health_body = {"status": "ok", "timestamp": "test"}
        client = module.NoosphereClient(
            base_url=self.base_url,
            api_key="noo_test",
            timeout=2.0,
        )

        result = client.status()

        self.assertEqual(result["status"], "ok")
        self.assertFalse(result["memoryStatusAvailable"])
        self.assertEqual(result["memoryStatusError"]["status"], 403)

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
            client.recall({"query": "deploy", "mode": "inspection"})

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

    def test_normalize_base_url_accepts_safe_targets_and_strips_fragments(self):
        module = load_plugin_package()
        normalize = module.NoosphereClient.__init__.__globals__["normalize_base_url"]

        cases = {
            "http://127.0.0.1:6578/path/?x=1#frag": "http://127.0.0.1:6578/path",
            "http://localhost:6578/": "http://localhost:6578",
            "http://[::1]:6578/": "http://[::1]:6578",
            "https://noosphere.example.test/base/": "https://noosphere.example.test/base",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(normalize(raw), expected)

    def test_normalize_base_url_rejects_unsafe_targets(self):
        module = load_plugin_package()
        normalize = module.NoosphereClient.__init__.__globals__["normalize_base_url"]

        cases = [
            "file:///tmp/noosphere.sock",
            "https://user:pass@noosphere.example.test",
            "http://noosphere.example.test",
            "https://10.0.0.5",
            "https://172.16.0.5",
            "https://192.168.1.5",
            "https://169.254.169.254",
            "https://2130706433",
            "https://0177.0.0.1",
            "https://0x7f.0.0.1",
            "https://[fc00::1]",
            "https://[fd00::1]",
            "https://[fe80::1]",
            "https://[fe80::1%25eth0]",
            "https://[ff02::1]",
            "https://[::ffff:192.168.1.5]",
            "https://[2001:db8::1]",
        ]
        for raw in cases:
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    normalize(raw)

    def test_status_and_recall_allow_call_specific_timeouts(self):
        module = load_plugin_package()
        client = module.NoosphereClient(
            base_url=self.base_url,
            api_key="noo_test",
            timeout=15.0,
            auto_recall_timeout=1.25,
            status_timeout=0.75,
        )

        client_globals = module.NoosphereClient._request_json.__globals__
        with mock.patch.object(
            client_globals["urllib"].request,
            "urlopen",
            return_value=_JsonResponse({"ok": True}),
        ) as urlopen:
            client.status()
            client.recall({"query": "deploy"}, timeout=1.25)

        self.assertEqual(urlopen.call_args_list[0].kwargs["timeout"], 0.75)
        self.assertEqual(urlopen.call_args_list[1].kwargs["timeout"], 1.25)


if __name__ == "__main__":
    unittest.main()
