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
        self.saved = []

    def save(self, request):
        self.saved.append(request)
        return {"success": True, "candidate": {"title": request["title"]}}


class NoosphereSavePhase4Test(unittest.TestCase):
    def initialized_provider(self, *, topic_id="topic-1", auto_capture=False, context="primary"):
        module = load_plugin()
        provider = module.NoosphereMemoryProvider()
        with tempfile.TemporaryDirectory() as hermes_home:
            Path(hermes_home, "noosphere.json").write_text(
                json.dumps({"topic_id": topic_id, "auto_capture": auto_capture}),
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {"NOOSPHERE_API_KEY": "noo_test"}, clear=True):
                provider.initialize(
                    "session-1",
                    hermes_home=hermes_home,
                    agent_identity="coder",
                    agent_context=context,
                )
        provider._client = _FakeClient()
        return provider

    def test_save_tool_uses_default_topic_and_author_template(self):
        provider = self.initialized_provider(topic_id="topic-1")

        result = json.loads(
            provider.handle_tool_call(
                "noosphere_save",
                {
                    "title": "Deployment rule",
                    "content": "<memory-context>Use pkapp PM2.</memory-context>",
                    "tags": ["ops", ""],
                },
            )
        )

        self.assertTrue(result["success"])
        saved = provider._client.saved[0]
        self.assertEqual(saved["topicId"], "topic-1")
        self.assertEqual(saved["authorName"], "Hermes:coder")
        self.assertEqual(saved["content"], "Use pkapp PM2.")
        self.assertEqual(saved["tags"], ["ops"])

    def test_memory_write_mirror_runs_async_when_topic_is_configured(self):
        provider = self.initialized_provider(topic_id="topic-1")

        provider.on_memory_write("add", "memory", "Remember this durable operating fact.")
        provider.shutdown()

        self.assertEqual(len(provider._client.saved), 1)
        self.assertEqual(provider._client.saved[0]["tags"], ["hermes", "explicit-memory", "memory"])

    def test_memory_write_mirror_skips_subagent_context(self):
        provider = self.initialized_provider(topic_id="topic-1", context="subagent")

        provider.on_memory_write("add", "memory", "Remember this durable operating fact.")
        provider.shutdown()

        self.assertEqual(provider._client.saved, [])

    def test_sync_turn_requires_auto_capture_and_topic(self):
        provider = self.initialized_provider(topic_id="topic-1", auto_capture=True)

        provider.sync_turn("The user selected option B.", "I implemented option B.")
        provider.shutdown()

        self.assertEqual(len(provider._client.saved), 1)
        self.assertIn("[role: user]", provider._client.saved[0]["content"])


if __name__ == "__main__":
    unittest.main()
