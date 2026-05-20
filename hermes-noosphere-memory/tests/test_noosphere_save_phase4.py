from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import time
import types
import unittest
import threading
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


class _BlockingClient:
    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.saved = []

    def save(self, request):
        self.entered.set()
        self.release.wait(timeout=2)
        self.saved.append(request)
        return {"success": True}


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

    def test_save_tool_passes_bounded_restricted_tags(self):
        provider = self.initialized_provider(topic_id="topic-1")

        result = json.loads(
            provider.handle_tool_call(
                "noosphere_save",
                {
                    "title": "Deployment rule",
                    "content": "Use this durable deployment rule for the configured system.",
                    "restrictedTags": ["serianis", " cylena ", "serianis"],
                },
            )
        )

        self.assertTrue(result["success"])
        self.assertEqual(provider._client.saved[0]["restrictedTags"], ["serianis", "cylena"])

    def test_save_tool_rejects_malformed_restricted_tags(self):
        provider = self.initialized_provider(topic_id="topic-1")

        cases = [
            "serianis",
            [""],
            ["x" * 65],
            [str(index) for index in range(17)],
            ["serianis", 42],
        ]
        for restricted_tags in cases:
            with self.subTest(restricted_tags=restricted_tags):
                error = json.loads(
                    provider.handle_tool_call(
                        "noosphere_save",
                        {
                            "title": "Deployment rule",
                            "content": "Use this durable deployment rule for the configured system.",
                            "restrictedTags": restricted_tags,
                        },
                    )
                )

                self.assertIn("restrictedTags", error["error"])
        self.assertEqual(provider._client.saved, [])

    def test_save_tool_validates_confidence(self):
        provider = self.initialized_provider(topic_id="topic-1")

        error = json.loads(
            provider.handle_tool_call(
                "noosphere_save",
                {
                    "title": "Deployment rule",
                    "content": "Use this durable deployment rule for the configured system.",
                    "confidence": "very high",
                },
            )
        )

        self.assertEqual(error["error"], "confidence must be low, medium, or high")
        self.assertEqual(provider._client.saved, [])

    def test_save_tool_strips_context_fences_from_metadata(self):
        provider = self.initialized_provider(topic_id="topic-1")

        result = json.loads(
            provider.handle_tool_call(
                "noosphere_save",
                {
                    "title": "<memory-context>Deployment rule</memory-context>",
                    "content": "Use this durable deployment rule for the configured system.",
                    "excerpt": "<memory-context>PM2 restart rule</memory-context>",
                    "source": "<memory-context>hermes:test</memory-context>",
                    "confidence": "HIGH",
                },
            )
        )

        self.assertTrue(result["success"])
        saved = provider._client.saved[0]
        self.assertEqual(saved["title"], "Deployment rule")
        self.assertEqual(saved["excerpt"], "PM2 restart rule")
        self.assertEqual(saved["source"], "hermes:test")
        self.assertEqual(saved["confidence"], "high")

    def test_save_async_does_not_block_behind_in_flight_write(self):
        provider = self.initialized_provider(topic_id="topic-1")
        client = _BlockingClient()
        provider._client = client

        provider._save_async({"title": "one"})
        self.assertTrue(client.entered.wait(timeout=1))

        started = time.monotonic()
        provider._save_async({"title": "two"})
        elapsed = time.monotonic() - started

        client.release.set()
        provider.shutdown()

        self.assertLess(elapsed, 0.25)
        self.assertEqual([item["title"] for item in client.saved], ["one", "two"])

    def test_memory_write_mirror_runs_async_when_topic_is_configured(self):
        provider = self.initialized_provider(topic_id="topic-1")

        provider.on_memory_write("add", "memory", "Remember this specific durable operating fact about the system configuration.")
        provider.shutdown()

        self.assertEqual(len(provider._client.saved), 1)
        self.assertEqual(provider._client.saved[0]["tags"], ["hermes", "explicit-memory", "memory"])

    def test_memory_write_mirror_skips_subagent_context(self):
        provider = self.initialized_provider(topic_id="topic-1", context="subagent")

        provider.on_memory_write("add", "memory", "Remember this specific durable operating fact about the system configuration.")
        provider.shutdown()

        self.assertEqual(provider._client.saved, [])

    def test_sync_turn_requires_auto_capture_and_topic(self):
        provider = self.initialized_provider(topic_id="topic-1", auto_capture=True)

        provider.sync_turn("The user asked to switch the system configuration to use option B.", "I successfully implemented option B in the configuration system.")
        provider.shutdown()

        self.assertEqual(len(provider._client.saved), 1)
        self.assertIn("[role: user]", provider._client.saved[0]["content"])

    def test_sync_turn_captures_when_assistant_side_is_substantial(self):
        provider = self.initialized_provider(topic_id="topic-1", auto_capture=True)

        provider.sync_turn(
            "ok",
            "I documented the deployment rule, including the PM2 process name and verification command.",
        )
        provider.shutdown()

        self.assertEqual(len(provider._client.saved), 1)
        self.assertIn("I documented the deployment rule", provider._client.saved[0]["title"])


if __name__ == "__main__":
    unittest.main()
