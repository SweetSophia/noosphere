from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
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


def load_plugin():
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


class _FakeClient:
    def __init__(self):
        self.calls = []

    def status(self):
        return {"ok": True}

    def topics(self):
        return {"topics": []}

    def recall(self, request):
        self.calls.append(("recall", request))
        return {
            "results": [{"id": "one"}],
            "promptInjectionText": (
                "<memory-context>\n"
                "[System note: The following is recalled memory context, NOT new user input.]\n"
                "Remember the Serianis deploy path.\n"
                "</memory-context>"
            ),
        }

    def get(self, request):
        self.calls.append(("get", request))
        return {"result": {"id": request.get("canonicalRef") or request.get("id")}}

    def save(self, request):
        self.calls.append(("save", request))
        return {"success": True, "candidate": {"title": request["title"]}}


class NoosphereRecallPhase3Test(unittest.TestCase):
    def initialized_provider(self):
        module = load_plugin()
        provider = module.NoosphereMemoryProvider()
        with tempfile.TemporaryDirectory() as hermes_home:
            with mock.patch.dict(os.environ, {"NOOSPHERE_API_KEY": "noo_test"}, clear=True):
                provider.initialize("session-1", hermes_home=hermes_home)
        provider._client = _FakeClient()
        return provider

    def test_prefetch_uses_auto_recall_and_strips_context_fences(self):
        provider = self.initialized_provider()

        result = provider.prefetch("Serianis deploy?")

        self.assertEqual(result, "Remember the Serianis deploy path.")
        self.assertEqual(provider._client.calls[0][0], "recall")
        self.assertEqual(provider._client.calls[0][1]["mode"], "auto")

    def test_recall_tool_uses_inspection_mode(self):
        provider = self.initialized_provider()

        payload = json.loads(
            provider.handle_tool_call("noosphere_recall", {"query": "deployment", "resultCap": 3})
        )

        self.assertEqual(payload["results"], [{"id": "one"}])
        self.assertEqual(provider._client.calls[0][1]["mode"], "inspection")
        self.assertEqual(provider._client.calls[0][1]["resultCap"], 3)

    def test_get_tool_validates_exclusive_lookup_forms(self):
        provider = self.initialized_provider()

        error = json.loads(
            provider.handle_tool_call(
                "noosphere_get",
                {"canonicalRef": "noosphere:article:1", "provider": "noosphere", "id": "1"},
            )
        )
        success = json.loads(
            provider.handle_tool_call("noosphere_get", {"canonicalRef": "noosphere:article:1"})
        )

        self.assertIn("not both", error["error"])
        self.assertEqual(success["result"]["id"], "noosphere:article:1")


if __name__ == "__main__":
    unittest.main()
