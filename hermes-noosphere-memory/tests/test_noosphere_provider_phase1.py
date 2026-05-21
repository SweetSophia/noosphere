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

        with mock.patch.dict(os.environ, {"NOOSPHERE_API_KEY": "   \t  "}, clear=True):
            self.assertFalse(provider.is_available())

        with mock.patch.dict(os.environ, {"NOOSPHERE_API_KEY": "noo_test"}, clear=True):
            self.assertTrue(provider.is_available())

        with mock.patch.dict(os.environ, {"HERMES_NOOSPHERE_API_KEY": "noo_test"}, clear=True):
            self.assertTrue(provider.is_available())

    def test_config_schema_uses_base_url_env_for_key_help(self):
        module = load_plugin()
        provider = module.NoosphereMemoryProvider()

        with mock.patch.dict(
            os.environ,
            {
                "HERMES_NOOSPHERE_BASE_URL": "https://hermes-noosphere.test/",
                "NOOSPHERE_BASE_URL": "https://generic-noosphere.test/",
            },
            clear=True,
        ):
            schema = provider.get_config_schema()

        self.assertEqual(schema[0]["env_var"], "HERMES_NOOSPHERE_API_KEY")
        self.assertEqual(schema[0]["url"], "https://hermes-noosphere.test/wiki/admin/keys")

    def test_save_config_persists_non_secret_values(self):
        module = load_plugin()
        provider = module.NoosphereMemoryProvider()

        with tempfile.TemporaryDirectory() as hermes_home:
            provider.save_config(
                {
                    "api_key": "noo_secret",
                    "base_url": "https://example.test:6578/",
                    "auto_capture": "true",
                    "auto_recall_timeout": 99,
                    "status_timeout": 99,
                    "max_recall_results": 99,
                },
                hermes_home,
            )

            path = Path(hermes_home) / "noosphere.json"
            data = json.loads(path.read_text(encoding="utf-8"))

        self.assertNotIn("api_key", data)
        self.assertEqual(data["base_url"], "https://example.test:6578")
        self.assertTrue(data["auto_capture"])
        self.assertEqual(data["auto_recall_timeout"], 10.0)
        self.assertEqual(data["status_timeout"], 10.0)
        self.assertEqual(data["max_recall_results"], 20)
        self.assertNotIn("providers", data)

    def test_save_config_treats_blank_base_url_as_default(self):
        module = load_plugin()
        provider = module.NoosphereMemoryProvider()

        with tempfile.TemporaryDirectory() as hermes_home:
            provider.save_config({"base_url": "", "auto_recall": False}, hermes_home)

            path = Path(hermes_home) / "noosphere.json"
            data = json.loads(path.read_text(encoding="utf-8"))

        self.assertEqual(data["base_url"], "http://127.0.0.1:6578")
        self.assertFalse(data["auto_recall"])

    def test_save_config_removes_legacy_secret_from_existing_file(self):
        module = load_plugin()
        provider = module.NoosphereMemoryProvider()

        with tempfile.TemporaryDirectory() as hermes_home:
            path = Path(hermes_home) / "noosphere.json"
            path.write_text(
                json.dumps({"api_key": "noo_legacy", "base_url": "https://stored.test"}),
                encoding="utf-8",
            )

            provider.save_config({"auto_capture": True}, hermes_home)

            data = json.loads(path.read_text(encoding="utf-8"))

        self.assertNotIn("api_key", data)
        self.assertEqual(data["base_url"], "https://stored.test")
        self.assertTrue(data["auto_capture"])

    def test_save_config_logs_and_rebuilds_corrupt_existing_file(self):
        module = load_plugin()
        provider = module.NoosphereMemoryProvider()

        with tempfile.TemporaryDirectory() as hermes_home:
            path = Path(hermes_home) / "noosphere.json"
            path.write_text("{not-json", encoding="utf-8")

            with self.assertLogs(module.logger, level="WARNING") as logs:
                provider.save_config({"base_url": "https://rebuilt.test"}, hermes_home)

            data = json.loads(path.read_text(encoding="utf-8"))

        self.assertIn("Failed to parse existing Noosphere config", "\n".join(logs.output))
        self.assertEqual(data["base_url"], "https://rebuilt.test")

    def test_initialize_loads_context_and_disables_writes_for_subagents(self):
        module = load_plugin()
        provider = module.NoosphereMemoryProvider()

        with tempfile.TemporaryDirectory() as hermes_home:
            path = Path(hermes_home) / "noosphere.json"
            path.write_text(
                json.dumps({"base_url": "https://stored.test", "auto_recall": False}),
                encoding="utf-8",
            )

            with mock.patch.dict(
                os.environ,
                {
                    "HERMES_NOOSPHERE_API_KEY": "noo_hermes",
                    "NOOSPHERE_API_KEY": "noo_generic",
                    "HERMES_NOOSPHERE_BASE_URL": "https://hermes-env.test/",
                    "NOOSPHERE_BASE_URL": "https://generic-env.test/",
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
        self.assertEqual(provider._api_key, "noo_hermes")
        self.assertEqual(provider._config["base_url"], "https://hermes-env.test")
        self.assertEqual(provider._agent_identity, "coder")

    def test_initialize_uses_hermes_home_env_when_kwarg_missing(self):
        module = load_plugin()
        provider = module.NoosphereMemoryProvider()

        with tempfile.TemporaryDirectory() as hermes_home:
            path = Path(hermes_home) / "noosphere.json"
            path.write_text(json.dumps({"base_url": "https://env-home.test"}), encoding="utf-8")

            with mock.patch.dict(
                os.environ,
                {"NOOSPHERE_API_KEY": "noo_test", "HERMES_HOME": hermes_home},
                clear=True,
            ):
                provider.initialize("session-1")

        self.assertEqual(provider._hermes_home, hermes_home)
        self.assertEqual(provider._config["base_url"], "https://env-home.test")

    def test_initialize_disables_provider_for_unsafe_env_base_url(self):
        module = load_plugin()
        provider = module.NoosphereMemoryProvider()

        with tempfile.TemporaryDirectory() as hermes_home:
            with mock.patch.dict(
                os.environ,
                {
                    "NOOSPHERE_API_KEY": "noo_test",
                    "NOOSPHERE_BASE_URL": "https://169.254.169.254",
                },
                clear=True,
            ):
                with self.assertLogs(module.logger, level="WARNING") as logs:
                    provider.initialize("session-1", hermes_home=hermes_home)

        self.assertFalse(provider._active)
        self.assertIsNone(provider._client)
        self.assertIn("Unsafe Hermes Noosphere base URL ignored", "\n".join(logs.output))

    def test_initialize_disables_provider_for_unsafe_stored_base_url(self):
        module = load_plugin()
        provider = module.NoosphereMemoryProvider()

        with tempfile.TemporaryDirectory() as hermes_home:
            path = Path(hermes_home) / "noosphere.json"
            path.write_text(json.dumps({"base_url": "https://169.254.169.254"}), encoding="utf-8")

            with mock.patch.dict(os.environ, {"NOOSPHERE_API_KEY": "noo_test"}, clear=True):
                with self.assertLogs(module.logger, level="WARNING") as logs:
                    provider.initialize("session-1", hermes_home=hermes_home)

        self.assertFalse(provider._active)
        self.assertIsNone(provider._client)
        self.assertIn("Unsafe Noosphere config", "\n".join(logs.output))

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
