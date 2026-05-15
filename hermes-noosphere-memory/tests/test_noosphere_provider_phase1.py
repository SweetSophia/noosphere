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


PLUGIN_PATH = (
    Path(__file__).resolve().parents[1]
    / "plugins"
    / "memory"
    / "noosphere"
    / "__init__.py"
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
            PLUGIN_PATH,
            submodule_search_locations=[str(PLUGIN_PATH.parent)],
        )
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        with mock.patch.dict(sys.modules, {"noosphere_memory_plugin": module}):
            spec.loader.exec_module(module)
            return module


class NoosphereProviderPhase1Test(unittest.TestCase):
    def test_is_available_checks_only_api_key_env(self):
        module = load_plugin()
        provider = module.NoosphereMemoryProvider()

        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(provider.is_available())

        with mock.patch.dict(os.environ, {"NOOSPHERE_API_KEY": "noo_test"}, clear=True):
            self.assertTrue(provider.is_available())

    def test_save_config_persists_non_secret_values(self):
        module = load_plugin()
        provider = module.NoosphereMemoryProvider()

        with tempfile.TemporaryDirectory() as hermes_home:
            provider.save_config(
                {
                    "api_key": "noo_secret",
                    "base_url": "http://example.test:6578/",
                    "auto_capture": "true",
                    "max_recall_results": 99,
                    "providers": ["noosphere", "noosphere", "hindsight"],
                },
                hermes_home,
            )

            path = Path(hermes_home) / "noosphere.json"
            data = json.loads(path.read_text(encoding="utf-8"))

        self.assertNotIn("api_key", data)
        self.assertEqual(data["base_url"], "http://example.test:6578")
        self.assertTrue(data["auto_capture"])
        self.assertEqual(data["max_recall_results"], 20)
        self.assertEqual(data["providers"], ["noosphere", "hindsight"])

    def test_initialize_loads_context_and_disables_writes_for_subagents(self):
        module = load_plugin()
        provider = module.NoosphereMemoryProvider()

        with tempfile.TemporaryDirectory() as hermes_home:
            path = Path(hermes_home) / "noosphere.json"
            path.write_text(
                json.dumps({"base_url": "http://stored.test", "auto_recall": False}),
                encoding="utf-8",
            )

            with mock.patch.dict(
                os.environ,
                {
                    "NOOSPHERE_API_KEY": "noo_test",
                    "NOOSPHERE_BASE_URL": "http://env.test/",
                },
                clear=True,
            ):
                provider.initialize(
                    "session-1",
                    hermes_home=hermes_home,
                    platform="cli",
                    agent_identity="coder",
                    agent_context="subagent",
                )

        self.assertTrue(provider._active)
        self.assertFalse(provider._write_enabled)
        self.assertEqual(provider._config["base_url"], "http://env.test")
        self.assertEqual(provider._agent_identity, "coder")

    def test_register_adds_memory_provider(self):
        module = load_plugin()
        registered = []

        class Ctx:
            def register_memory_provider(self, provider):
                registered.append(provider)

        module.register(Ctx())

        self.assertEqual(len(registered), 1)
        self.assertEqual(registered[0].name, "noosphere")

    def test_status_tool_schema_is_registered(self):
        module = load_plugin()
        provider = module.NoosphereMemoryProvider()

        schemas = provider.get_tool_schemas()

        self.assertEqual(
            [schema["name"] for schema in schemas],
            [
                "noosphere_status",
                "noosphere_recall",
                "noosphere_get",
                "noosphere_topics",
                "noosphere_save",
            ],
        )


if __name__ == "__main__":
    unittest.main()
