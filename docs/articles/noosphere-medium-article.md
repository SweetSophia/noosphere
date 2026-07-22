# How to Give AI Agents a Memory Humans Can Read, Edit, and Trust

## Noosphere turns agent memory from a hidden recall mechanism into a shared, API-first knowledge base for agents, coding CLIs, and the people who work with them.

If you work with AI agents long enough, the same failure mode appears again and again.

It is not simply that agents forget things.

It is that you cannot reliably see what they remember, why they remember it, whether it is still true, or how to fix it when it is wrong.

That is manageable when an agent is answering small questions. It becomes expensive when agents are working on real projects: deployment notes, API decisions, bug investigations, credentials routing rules, operational runbooks, PR review conclusions, system architecture, and the tiny details that matter three weeks later when something breaks at 2 AM.

Hidden memory is useful until you need to trust it.

Noosphere is my attempt to solve that trust problem.

By the end of this article, you should understand:

- why agent memory needs to become editable project knowledge;
- what Noosphere adds beyond ordinary vector or transcript recall;
- how agents and humans can use the same memory layer together;
- how to try it directly, with OpenClaw, or with Hermes Agent.

> The transformation is simple: move from "the agent might remember" to "the team has a living knowledge base the agent can use."

## Why I Built It

Noosphere started as a wiki-like project for my agents.

The first idea was simple: give agents a searchable place to store and retrieve useful knowledge. I deliberately chose an API-first design instead of raw Markdown files as the primary interface. Markdown is wonderful for humans and export, but an API gives agents a clearer contract: create, update, search, recall, filter, scope, audit, and retrieve by stable IDs.

Two days after I started building it, Andrej Karpathy published his Agent Wiki idea.

The timing was strange, but useful. It confirmed the direction: agents need a shared, readable knowledge base. Not just hidden vectors. Not just chat history. A wiki they can use.

So I kept building.

Then my local OpenClaw QMD index corrupted.

I rebuilt it three times. It took two full machine-days in total because my OpenClaw installation had grown large. Even after that, it still did not feel reliable enough for the kind of work I needed. I tested other memory systems. Hindsight worked well and I still consider it useful, especially for automatic capture and recall.

But I kept running into the same gap.

The memory layer was either too opaque, too hard to edit, too tied to one harness, too unstructured, or not designed around a human-readable project knowledge base.

I wanted memory that agents could write to easily, retrieve automatically, query manually, and update as the project changed.

I also wanted the human side of the system to matter. I wanted to open a web UI, read the stored knowledge, edit it, organize it, restrict it, attach images, review revisions, and decide what deserved to become durable truth.

At some point I was browsing my own GitHub repositories and stumbled back onto the wiki I had started.

That was the answer.

Not finished. Not polished yet. But the right foundation.

Noosphere is what happened when that wiki became a real agent memory system.

## What Was Missing From Existing Memory Systems

I am not trying to replace every memory system. Different systems have different strengths. Hindsight is good at passive capture and recall. QMD is useful as a local index. mem0, memU, and vector-store based systems solve other parts of the problem.

The problem was that none of them gave me the full combination I wanted for agentic software work:

- A full web UI where humans can browse, edit, review, delete, restore, and organize memory.
- Durable wiki-style articles instead of isolated facts or hidden embeddings.
- API-first storage and retrieval, so agents and coding CLIs can integrate cleanly.
- Auto-recall and manual recall, so memory can appear when useful but also be queried explicitly.
- Human review workflows: draft, reviewed, published.
- Confidence metadata: low, medium, high.
- Topic hierarchy with unlimited depth.
- Tags, article relations, source metadata, and activity logs.
- Revision history, so edits are inspectable.
- Soft delete and trash recovery.
- Scoped API keys and restricted articles for sensitive knowledge.
- Prompt-safe recall budgeting, so the memory layer does not flood the context window.
- Multi-provider recall orchestration, so Noosphere can combine its own curated articles with systems like Hindsight.
- Cross-provider deduplication and conflict handling.
- Promotion workflows, so frequently useful memory can move from ephemeral material toward curated knowledge.
- Backfill and synthesis jobs for turning older material into structured articles.
- Local scheduling for memory maintenance.
- Image support for articles.
- Markdown vault export/import and Obsidian-friendly workflows.

That combination matters because agent memory is not just recall. It is governance.

If an agent stores the wrong deployment command, a human should be able to fix it. If two sources disagree, the conflict should be visible. If a memory is private, access should be scoped. If a note is only a draft, it should not pretend to be curated truth. If a project changes, the knowledge base should be editable without rebuilding an index from scratch.

That is the core difference Noosphere is trying to offer: not merely "the agent remembers," but "the agent and the human maintain a shared knowledge system."

## What Noosphere Is Now

Noosphere is a universal memory and knowledge layer for AI agents. It is structured enough for automation and readable enough for humans.

At a high level, it gives you:

- A wiki UI for humans.
- A REST API for agents.
- PostgreSQL-backed full-text search.
- Topic trees, tags, article relations, confidence, status, revisions, and activity logs.
- API key authentication with READ, WRITE, and ADMIN permissions.
- Scoped access for restricted articles.
- Article images and embedded media.
- Markdown vault export/import for Obsidian-style workflows.
- A provider-agnostic memory layer.
- Recall orchestration across Noosphere, Hindsight, and future providers.
- Ranking based on relevance, confidence, recency, and curation.
- Deduplication and conflict handling.
- Token-bounded prompt-ready recall blocks.
- Memory promotion and backfill workflows.
- Local memory scheduling.
- OpenClaw plugin support.
- Hermes Agent memory provider support.

The important design choice is that Noosphere is not bound to one agent harness.

It is a web application and memory service with an HTTP API. That means almost any agent runtime, coding CLI, or assistant framework can integrate with it through a plugin, tool, MCP server, SDK wrapper, or direct REST calls. OpenClaw and Hermes are already supported. OpenCode support is planned. Other integrations are very possible because the boundary is simple: authenticate, save, search, recall, get, and update.

## What This Lets You Do

Noosphere is not only a place to store notes.

It changes the way agent projects can be run.

With a working Noosphere setup, you can:

- give every agent access to the same current project knowledge;
- let agents recall deployment rules, decisions, and runbooks before they act;
- save new findings as draft memory instead of losing them in chat history;
- review and edit memory through a normal web UI;
- restrict sensitive knowledge by API key scope;
- export the knowledge base as Markdown when you want portability;
- connect the same memory service to more than one agent harness.

That is the transformation I care about: **agents stop acting like isolated sessions and start behaving like contributors to a maintained project brain.**

## From Wiki To Memory System

The first version of Noosphere was the obvious thing: articles organized into topics.

An agent could save a useful answer. A human could browse it later. External material could be ingested into structured articles. The system had enough wiki behavior to be useful: topics, tags, Markdown rendering, search, article pages, editing, and admin tools.

But a wiki alone is not an agent memory system.

Agent memory needs to participate in the prompt loop.

So Noosphere gained a memory layer. Internally, memory providers return a normalized result shape. The recall orchestrator can fan out to several providers, collect results, rank them, deduplicate overlap, surface conflicts, and apply a token budget before generating prompt-ready context.

The flow looks like this:

    Query
      -> provider fan-out
      -> ranking
      -> deduplication
      -> conflict handling
      -> token/result budgeting
      -> prompt-ready recall block

The built-in Noosphere provider searches structured wiki articles. A Hindsight provider can be used as another source. Future providers can implement the same interface.

That is where Noosphere becomes more than a wiki. It becomes an orchestrator for durable knowledge.

The next step was capture.

Noosphere does not try to silently publish every thought an agent has. That would make the wiki noisy fast. Instead, it supports safer memory capture patterns:

- Agents can explicitly save draft memory candidates.
- Agents can create curated articles when they have permission.
- Research answers can be saved as articles.
- External sources can be ingested into multiple articles.
- Repeatedly useful memories can be promoted for review.
- Backfill jobs can synthesize older material into structured knowledge.

That creates a healthier workflow. The system can capture quickly, but curated memory remains reviewable.

## How Agents And Humans Use It Together

Here is the practical workflow Noosphere is built for.

An agent starts a task. Before it answers, the Noosphere integration can recall relevant project knowledge and inject a bounded context block. The agent sees the deployment notes, the prior bug investigation, the API decision, or the test command that matters.

During the task, the agent can query Noosphere manually:

- "What did we decide about the upload API?"
- "Where is the production Docker compose file?"
- "What is the rollback procedure?"
- "Which articles mention the memory scheduler?"

After the task, the agent can save what changed:

- A draft memory candidate for a new deployment procedure.
- A curated article for a stable architecture decision.
- A correction to an existing article.
- A link between related articles.
- A note that a previous assumption is stale.

The human can then open the wiki, review the article, edit wording, change status, restrict access, attach images, or delete outdated knowledge.

This matters a lot on real projects.

Imagine a project called Saiteris, a price comparison and operations platform. Several agents work on it across frontend, scraping, admin tools, deployment, and incident response. Without durable memory, every agent starts from a partial transcript and a pile of assumptions.

With Noosphere, the project can have living articles like:

- "Saiteris Deployment Runbook"
- "Database Connection Rules"
- "Admin Dashboard Auth Notes"
- "Known Scraper Failure Modes"
- "Nginx Maintenance Mode Recovery"
- "Product Import Pipeline"
- "Release Checklist"

When an agent is asked to fix a production issue, it does not need to rediscover the whole system. It can recall the relevant runbook. If the runbook is wrong, the agent or human can update it. If a new incident reveals a better procedure, that becomes durable project knowledge.

That is how you get faster without becoming reckless.

## What Makes It Different

The short version:

Noosphere treats memory as knowledge management, not just retrieval.

The longer version:

### 1. It Is Human-Editable

The memory is not trapped in embeddings. It is visible as articles. You can open the wiki, read the knowledge, edit it, and decide whether it is draft, reviewed, or published.

### 2. It Is API-First

Agents do not need to write raw files into a vault. They call stable endpoints. That makes integration easier and allows the server to enforce validation, permissions, scopes, activity logging, revision history, and search indexing.

### 3. It Supports Both Automatic And Manual Recall

Automatic recall is useful when the agent needs context without asking. Manual recall is useful when the agent or human wants to inspect memory directly. Noosphere supports both.

### 4. It Has A Real Curation Model

Not every memory should be treated as truth. Noosphere supports curation levels, confidence scoring, and article status. Drafts are not the same as reviewed knowledge.

### 5. It Handles Prompt Budgets

Dumping too much memory into a prompt is just another failure mode. Noosphere can cap results and tokens before recall text enters the agent context.

### 6. It Can Orchestrate Multiple Providers

Noosphere can recall from its own wiki articles and from other providers such as Hindsight. The orchestrator can rank, deduplicate, and handle conflicts across sources.

### 7. It Includes Access Control

API keys can have READ, WRITE, or ADMIN permissions. Articles can be restricted with scopes. Different agents can use different keys. This matters when the memory system stores sensitive project or personal knowledge.

### 8. It Works Outside One Harness

Noosphere is not only an OpenClaw feature. It is a standalone service. If your agent runtime can make HTTP calls, it can probably integrate with Noosphere.

## How To Try Noosphere

The repository is here:

https://github.com/SweetSophia/noosphere

Noosphere runs with Docker Compose and PostgreSQL.

Generic local setup:

    git clone https://github.com/SweetSophia/noosphere.git
    cd noosphere
    cp .env.example .env

    # Set these in .env:
    # DATABASE_URL
    # NEXTAUTH_SECRET
    # NEXTAUTH_URL
    # APP_URL
    # POSTGRES_PASSWORD

    docker compose up -d

Then open:

    http://localhost:4400/wiki

For local development:

    npm install
    docker compose up db -d
    npx prisma migrate dev
    npm run dev

The agent-facing API base is:

    http://localhost:4400/api

Use an API key with:

    Authorization: Bearer <api_key>

Common endpoints:

    GET  /api/articles?q=<query>
    GET  /api/topics
    POST /api/articles
    PATCH /api/articles/:id
    POST /api/ingest
    POST /api/answer
    GET  /api/graph
    GET  /api/export
    POST /api/import
    GET  /api/health

Memory endpoints:

    GET  /api/memory/status
    POST /api/memory/recall
    POST /api/memory/get
    POST /api/memory/save

Example recall:

    curl -s -X POST http://localhost:4400/api/memory/recall \
      -H "Authorization: Bearer noo_..." \
      -H "Content-Type: application/json" \
      -d '{"query":"deployment runbook","mode":"inspection","resultCap":5}'

Example draft memory save:

    curl -s -X POST http://localhost:4400/api/memory/save \
      -H "Authorization: Bearer noo_..." \
      -H "Content-Type: application/json" \
      -d '{
        "title":"Deployment Runbook Update",
        "content":"Use this command sequence after rebuilding the container...",
        "topicId":"<topic_id>",
        "tags":["deployment","runbook"]
      }'

By default, memory saves are draft candidates. That is intentional. Agents can capture knowledge without silently publishing it as curated truth.

## Using Noosphere With OpenClaw

Noosphere ships an OpenClaw plugin called noosphere-memory.

The plugin provides explicit tools:

- noosphere_status
- noosphere_recall
- noosphere_get
- noosphere_save
- noosphere_topics
- noosphere_article_create

It also supports automatic prompt-time recall through OpenClaw's before_prompt_build hook.

Quick install on the machine running OpenClaw Gateway:

    # Installer commit: 2d1b08f18da111e5942af3ce821d47afa72b9264
    # Expected SHA-256: 622df3c415d0380eb277fdd7036505215261229f114a4e1bab47faf1cfbaec9e
    installer="$(mktemp)"
    curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/2d1b08f18da111e5942af3ce821d47afa72b9264/install-openclaw.sh -o "$installer"
    printf '%s  %s\n' '622df3c415d0380eb277fdd7036505215261229f114a4e1bab47faf1cfbaec9e' "$installer" | sha256sum -c -
    bash "$installer" && rm -f "$installer"
    openclaw noosphere doctor
    openclaw noosphere status

The installer creates a local Noosphere runtime, writes OpenClaw secrets outside the repository, installs the plugin, and patches OpenClaw config.

Default runtime locations:

    Noosphere runtime: ~/.noosphere
    OpenClaw secret file: ~/.openclaw/secrets/noosphere-memory.json
    Default app URL: http://127.0.0.1:6578
    Docker image: ghcr.io/sweetsophia/noosphere:latest

If you want a pinned image version:

    NOOSPHERE_VERSION=v1.5.5 \
    NOOSPHERE_PORT=6578 \
    APP_URL=http://127.0.0.1:6578 \
    bash install-openclaw.sh

For auto-recall, OpenClaw must allow prompt injection for the plugin:

    {
      "plugins": {
        "entries": {
          "noosphere-memory": {
            "hooks": {
              "allowPromptInjection": true
            }
          }
        }
      }
    }

With auto-recall enabled, the plugin can inject two useful blocks:

- Memory capture guidance, so agents know when to save durable knowledge.
- Ranked recall results, deduplicated and conflict-aware within a token budget.

If you do not want global auto-recall, restrict it by agent or chat type, or leave explicit tools enabled and turn auto-recall off.

## Using Noosphere With Hermes Agent

Noosphere also ships a Hermes Agent memory provider.

This is a first-class Hermes MemoryProvider, not just a generic tool wrapper. It supports:

- status checks
- recall
- direct memory lookup
- topic listing
- draft memory saves
- auto-recall prefetch
- explicit memory-write mirroring
- optional broad turn capture

Install from a cloned Noosphere repository:

    git clone https://github.com/SweetSophia/noosphere.git
    cd noosphere/hermes-noosphere-memory
    ./install-hermes.sh

The installer copies the provider to:

    $HERMES_HOME/plugins/noosphere

It also installs a setup skill at:

    $HERMES_HOME/skills/noosphere-memory-hermes

Manual setup looks like this:

    mkdir -p "$HERMES_HOME/plugins"
    cp -R plugins/memory/noosphere "$HERMES_HOME/plugins/noosphere"
    hermes config set memory.provider noosphere

Store your key in:

    $HERMES_HOME/.env

For example:

    NOOSPHERE_API_KEY=noo_...

Then create or edit:

    $HERMES_HOME/noosphere.json

Example:

    {
      "base_url": "http://127.0.0.1:6578",
      "auto_recall": true,
      "auto_capture": false,
      "capture_mode": "explicit",
      "max_recall_results": 5,
      "token_budget": 1200,
      "topic_id": "",
      "author_name_template": "Hermes:{identity}",
      "api_timeout": 15.0
    }

Use scoped Noosphere API keys for each Hermes profile when you want different agents to see or write different knowledge areas.

## A Practical Way To Use It

If you are trying Noosphere for the first time, do not start by importing everything.

Start with one project.

Create a topic tree like:

    Project
      Architecture
      Deployment
      Debugging
      Decisions
      Runbooks
      Research

Then add five useful articles:

1. Current architecture overview.
2. Local development setup.
3. Deployment and rollback runbook.
4. Known failure modes.
5. Open questions and active decisions.

Give your agent a WRITE-scoped key. Let it save draft memory candidates during real work. Review those drafts in the web UI. Promote the useful ones. Delete the noisy ones. Edit the ones that are almost right.

After that, enable auto-recall for the agent.

This gives you a controlled loop:

    Work happens
      -> useful knowledge is saved as draft
      -> human or trusted agent reviews it
      -> curated memory improves future work
      -> future agents recall the improved knowledge

That loop is the point.

## Useful Links

- Noosphere repository: https://github.com/SweetSophia/noosphere
- README and feature overview: https://github.com/SweetSophia/noosphere/blob/master/README.md
- Memory architecture: https://github.com/SweetSophia/noosphere/blob/master/docs/NOOSPHERE-MEMORY-ARCHITECTURE.md
- OpenClaw setup guide: https://github.com/SweetSophia/noosphere/blob/master/docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md
- Hermes provider README: https://github.com/SweetSophia/noosphere/tree/master/hermes-noosphere-memory

## What I Want Noosphere To Become

Noosphere is still young, but the direction is clear.

I want it to become a practical knowledge layer for agents and humans working together: not just a vector database, not just a wiki, not just a plugin, but a durable shared memory system that any agent runtime can use.

The next obvious step is more integrations. OpenClaw and Hermes are already supported. OpenCode support is planned. I would love to see Noosphere connected to more coding CLIs, agent frameworks, local assistants, research tools, and team workflows.

If you are building agents, try it.

If something feels missing, open an issue.

If you want support for your favorite agent system, request it or help build it.

If you care about agent memory being readable, editable, scoped, searchable, and useful across long-running projects, Noosphere is very much in that direction.

GitHub:

https://github.com/SweetSophia/noosphere

Feature requests, issues, criticism, and pull requests are welcome.

The goal is simple: give agents a memory they can actually use, and give humans a memory they can actually trust.
