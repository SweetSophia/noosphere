# Noosphere Injected Memory

Internal helper package for removing transient injected-memory blocks before
Noosphere persists agent-authored content.

The package is intentionally adapter-neutral. The Noosphere server and OpenClaw
plugin depend on this package instead of depending on each other.

The package is published as a coordinated npm artifact from the
`v-openclaw-*` release boundary before the OpenClaw package. The server still
consumes it through a local workspace dependency, and OpenClaw bundles it so
installed plugin users do not need to install the helper separately.
