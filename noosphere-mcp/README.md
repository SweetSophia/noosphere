# Noosphere MCP

`@sweetsophia/noosphere-mcp` exposes Noosphere's memory and wiki API as a stdio Model Context Protocol server. It includes a guided Codex CLI installer and skill.

## Codex CLI quick install

Prerequisites:

- Node.js 22 or newer
- Codex CLI with MCP support, installed from a trusted source and available as
  `codex` on a trusted `PATH`
- A running Noosphere deployment and a permission-scoped API key

Install the MCP launcher and user-level Codex skill:

```bash
npx -y @sweetsophia/noosphere-mcp@1.13.1 install-codex
```

The installer:

- adds the global Codex MCP server `noosphere`;
- installs the skill at `~/.agents/skills/noosphere-memory/SKILL.md`;
- stores only the `npx` launcher and the names of approved Noosphere environment variables in Codex config;
- never accepts or writes an API key or other environment-variable value;
- is idempotent and refuses to overwrite unrelated/customized entries.

Set the credential in the environment that launches Codex:

```bash
export CODEX_NOOSPHERE_API_KEY="<your Noosphere API key>"
codex
```

The default endpoint is `http://127.0.0.1:6578`. Verify the launcher without exposing credentials:

```bash
codex mcp get noosphere --json
```

## Remote Noosphere deployments

Non-loopback endpoints must use HTTPS and must match an exact environment-bound origin:

```bash
export CODEX_NOOSPHERE_BASE_URL="https://noosphere.example.com"
export CODEX_NOOSPHERE_TRUSTED_ORIGIN="https://noosphere.example.com"
export CODEX_NOOSPHERE_API_KEY="<your Noosphere API key>"
codex
```

`NOOSPHERE_BASE_URL`, `NOOSPHERE_TRUSTED_ORIGIN`, `NOOSPHERE_API_KEY`, and `NOOSPHERE_TIMEOUT_MS` remain compatibility fallbacks. Codex-specific names take precedence.

## Tools

- `search_articles` — search/filter articles or list recent accessible articles
- `get_article` — fetch a normalized article by ID or canonical reference
- `save_memory` — save durable knowledge as a draft memory candidate
- `recall_memory` — run provider-aware recall in bounded automatic mode with optional result/token budgets
- `create_article` — create an intentional curated wiki article

The MCP annotations mark search/get/recall as read-only and save/create as additive writes.

`recall_memory` always requests the Noosphere API's `auto` mode. It does not expose
inspection mode because inspection conflict evidence can exceed the client's 1 MB
response limit. Use the Noosphere HTTP API directly when that diagnostic evidence is
required.

## Other MCP clients

Run the server directly through an MCP client that supports stdio:

```text
command: npx
args: -y @sweetsophia/noosphere-mcp@1.13.1
```

Pass credentials through the MCP process environment; do not embed them in repository configuration.

## Security properties

- Loopback HTTP is allowed; non-loopback HTTP is rejected.
- Remote HTTPS requires an exact trusted-origin environment pin.
- URL credentials, query strings, and fragments are rejected.
- All API requests use `redirect: "error"`.
- Responses are limited to 1 MB and requests time out after 5 seconds by default (bounded to 0.5–30 seconds).
- Successful responses must be JSON objects; error text is bounded.
- The server uses stdio only and does not open a listening port.
- The guided installer invokes the `codex` executable resolved from the caller's
  `PATH`; run it from the same trusted shell used for Codex administration.
- The installer rejects symlinked Codex-home and skill-destination path
  components before inspection or mutation.
- Installation succeeds only when both the raw TOML section and final
  `codex mcp get` readback contain the complete unique environment-name set.

## Environment variables

- `CODEX_NOOSPHERE_API_KEY` / `NOOSPHERE_API_KEY`
- `CODEX_NOOSPHERE_BASE_URL` / `NOOSPHERE_BASE_URL`
- `CODEX_NOOSPHERE_TRUSTED_ORIGIN` / `NOOSPHERE_TRUSTED_ORIGIN`
- `CODEX_NOOSPHERE_TIMEOUT_MS` / `NOOSPHERE_TIMEOUT_MS`

## Uninstall from Codex

```bash
codex mcp remove noosphere
rm ~/.agents/skills/noosphere-memory/SKILL.md
rmdir ~/.agents/skills/noosphere-memory
```

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
npm audit --audit-level=low
```
