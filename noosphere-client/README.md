# @sweetsophia/noosphere-client

Shared Noosphere REST client, response types, and recall formatting for agent adapters.

This package exists because the OpenCode, Kilo Code, and MCP adapters all speak the
same REST contract with the same wire format. Before extraction, `client.ts`,
`format.ts`, and `types.ts` were duplicated per adapter — the OpenCode and Kilo Code
copies differed by three lines. They now share one implementation.

## Install

Adapters consume it as a bundled `file:` dependency, so it ships inside the adapter
tarball and needs no separate install:

```json
"dependencies": {
  "@sweetsophia/noosphere-client": "file:../noosphere-client"
},
"bundledDependencies": ["@sweetsophia/noosphere-client"]
```

## Usage

```ts
import { NoosphereClient, formatAutoRecall } from "@sweetsophia/noosphere-client";

const client = new NoosphereClient({
  baseUrl: "http://127.0.0.1:6578",
  apiKey: process.env.NOOSPHERE_API_KEY,
  timeoutMs: 5_000,
  // ...remaining NoospherePluginConfig fields
});

const response = await client.recall({ query: "connection pooling" });
const block = formatAutoRecall(response); // <noosphere_auto_recall>…</noosphere_auto_recall>
```

## Adapter-specific behaviour

Only the missing-API-key message is host-specific. Supply it via
`missingApiKeyMessage` so the error names the adapter's own environment variable:

```ts
missingApiKeyMessage: "Set OPENCODE_NOOSPHERE_API_KEY for Opencode Noosphere memory requests, …"
```

Omit it to get the generic `NOOSPHERE_API_KEY` message.

Everything else host-specific — env var names, product strings, capture tags — stays
in each adapter's own `config.ts` and `capture.ts`.

## Injected-memory block tag

`formatAutoRecall` emits `<noosphere_auto_recall>`, exported as
`AUTO_RECALL_BLOCK_TAG`. The server strips that exact tag at the persistence layer
via `@sweetsophia/noosphere-injected-memory` (`INJECTED_MEMORY_BLOCKS`).

**If you change the tag, change the strip list too.** The two lists are not
currently tied together by any test — see issue [#333](https://github.com/SweetSophia/noosphere/issues/333),
which also records that the Hermes plugin writes a *different* tag
(`<memory-context>`) that the server does not strip.

## Checks

```bash
npm run typecheck   # tsc --noEmit over src/ and test/
npm test            # node --test over test/
npm run build       # emit dist/ (committed; CI verifies it is current)
```

`prepack` runs the tests and the build.
