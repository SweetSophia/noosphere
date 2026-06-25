# Noosphere Injected Memory

Internal helper package for removing transient injected-memory blocks before
Noosphere persists agent-authored content.

The package is intentionally adapter-neutral. The Noosphere server and OpenClaw
plugin depend on this package instead of depending on each other.

This package is not published independently to npm. It is consumed through local
workspace file dependencies, and the OpenClaw plugin bundles it so installed
plugin users do not need a separate package.
