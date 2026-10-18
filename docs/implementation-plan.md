# Implementation Plan

This document is the working plan for the first implementation cycle. It is
updated as milestones land; the per-topic documents under `docs/` are the
authoritative specifications for each area.

## Goal

Build a DeepSeek Harness plugin that provides persistent companion memory based
on the design of [`her.memory`](https://github.com/runs-agents/her.memory):

- One global, human-readable JSONL memory store shared by all DSH sessions.
- A native JavaScript port of the store, hybrid retrieval, lifecycle, and
  proposal-based consolidation; no Python runtime dependency.
- Model access through four tools and four focused skills; no automatic recall
  injection.
- A settings-panel sidebar page with four tabs, fully localized in English and
  Chinese.
- A separate verification profile (`her-memory-test`) based on the shipped web
  template, served on port 3090; the existing `web` profile is not modified.

## Decisions already made

| Topic | Decision |
|---|---|
| Integration | Native JavaScript port, JSONL-compatible with her.memory |
| Memory scope | One global store shared by all sessions |
| Recall | No automatic injection; the model calls `memory_search` |
| Capture | Explicit tools plus four skills; no per-turn LLM extraction |
| Consolidation | Full propose/review/execute/restore workflow with editable merged text |
| Deletion | Tools and UI archive by default; the settings page has a user-only permanent delete |
| Storage | `$DSH_HOME/her-memory/`, configurable |
| Config | Plugin-owned `config.json`, live updates, no plugin reload |
| Settings page | Four in-page tabs: Overview, Memories, Curation, Settings |
| Discoverability | Short system-prompt pointer plus the skill catalog; generic tool cards |
| Verification | New `her-memory-test` profile, model rows copied from `web`, port 3090 |

## Architecture

```
┌──────────────────────────── Host process ────────────────────────────┐
│  index.js                                                            │
│    ├─ lib/engine.js  ── one shared engine for every caller           │
│    │    ├─ store / retrieval / embeddings / lifecycle / consolidation │
│    ├─ lib/tools.js   ── 4 model tools                                 │
│    ├─ lib/skills.js  ── 4 runtime skills                              │
│    ├─ lib/prompt.js  ── short availability section                    │
│    └─ lib/api.js     ── /plugins/dsh-her-memory/api                   │
│                                                                       │
│  Browser                                                              │
│    client.js  ── settings.section page; calls the API                 │
└───────────────────────────────────────────────────────────────────────┘
```

The engine is the only writer of memory data. The tools and the settings API
call the same engine methods. The client never touches the filesystem.

## File layout

```
package.json
cordis.patch.yml
index.js
client.js
icon.svg
locale/en.json
locale/zh.json
lib/
  errors.js        typed errors and stable codes
  paths.js         DSH home, memory paths, directory creation
  util.js          timestamps, ids, cosine, tokenizer helpers
  config.js        defaults, load/save/validate/redact, state file
  store.js         JSONL load/write, lock, atomic write, snapshots, hits
  retrieval.js     BM25, RRF, hybrid ranking
  embeddings.js    Ollama / llama.cpp / OpenAI-compatible / none adapters
  lifecycle.js     add/update/archive, maintenance, backfill, stamps
  version-stamp.js content hash and semantic_version.json
  consolidation.js proposal generation, execution, restore, delete
  engine.js        engine facade used by tools and the API
  tools.js         four tool definitions
  skills.js        runtime skill registration
  prompt.js        short system-prompt section
  api.js           same-origin JSON API route
skills/
  her-memory.md
  memory-recall.md
  memory-capture.md
  memory-curation.md
test/
  helpers.js
  fake-backend.js
  store.test.js
  config.test.js
  retrieval.test.js
  embeddings.test.js
  lifecycle.test.js
  consolidation.test.js
  engine.test.js
  tools.test.js
  api.test.js
docs/
  README.md
  architecture.md
  data-model.md
  retrieval.md
  configuration.md
  memory-tools.md
  memory-skills.md
  settings-page.md
  localization.md
  consolidation.md
  security-and-privacy.md
  testing-and-verification.md
  verification-profile.md
  implementation-plan.md
```

## Data location

```
$DSH_HOME/her-memory/
  config.json                    plugin configuration (0600 when supported)
  state.json                     last maintenance/proposal/backfill timestamps
  memories/                      default memoryDir
    semantic_memories.jsonl      active + archived-marked entries
    archived_memories.jsonl      physically archived entries
    retrieval_hits.jsonl         append-only hit log
    semantic_version.json        content stamp
    _snapshots/                  pre-destructive-operation copies
    _proposals/                  consolidation proposals
```

`config.json` may set `memoryDir` to any directory, including an existing
her.memory checkout. The plugin never stores data in its package directory.

## Data model

The JSONL record is compatible with her.memory's schema. See
[`data-model.md`](data-model.md) for the field table and lifecycle rules.

Core fields: `id`, `text`, `type`, `category`, `timestamp`, `embedding`,
`archived`, `energy`, `last_hit`.

Optional fields: `event_date`, `project_key`, `stable_key`, supersede-chain
fields, merge-chain fields, `origin` (DSH session/tool provenance), and
`archive_date` / `archive_reason`.

## Engine contract

`createEngine({ ctx, config, logger })` returns an object with:

```js
await engine.ready
engine.init()
engine.getState()
engine.getConfig()
engine.saveConfig(patch)
engine.testBackend({ chat })
engine.search({ query, topK, category, type, includeArchived, signal })
engine.add({ text, type, category, eventDate, projectKey, dedupe, origin, signal })
engine.update({ id, text, type, category, eventDate, origin, signal })
engine.archive({ id, reason, origin, signal })
engine.list({ query, category, type, includeArchived, offset, limit, signal })
engine.delete({ id, confirm, signal })
engine.maintain({ signal })
engine.backfill({ all, signal })
engine.stamp()
engine.propose({ signal })
engine.listProposals()
engine.getProposal(id)
engine.executeProposal({ id, groups, archiveIds, mergedTexts, signal })
engine.restoreProposal(id)
engine.exportData()
engine.importData({ jsonl, backfill, signal })
```

All failures throw `HermemoryError` with:

```js
{ code, message, status, details }
```

Stable codes: `INVALID_INPUT`, `STORE_LOCKED`, `STORE_IO`, `NOT_FOUND`,
`DUPLICATE`, `BACKEND_UNAVAILABLE`, `EMBEDDING_FAILED`, `CHAT_FAILED`,
`PROPOSAL_NOT_FOUND`, `PROPOSAL_NOT_EXECUTED`, `SNAPSHOT_NOT_FOUND`,
`IMPORT_INVALID`, `EXPORT_TOO_LARGE`, `UNKNOWN`.

## Backends

`config.backend.kind` is one of `ollama`, `llama-cpp`, `openai-compatible`, or
`none`.

| Kind | Embeddings | Chat |
|---|---|---|
| `ollama` | `POST /api/embeddings` `{model, prompt}` | `POST /api/generate` `{model, prompt, stream:false, options:{temperature}}` |
| `llama-cpp` | `POST /v1/embeddings` `{model, input}` | `POST /v1/chat/completions` `{model, messages, temperature, stream:false}` |
| `openai-compatible` | same OpenAI wire shape as llama-cpp | same OpenAI wire shape |
| `none` | no embeddings; keyword-only retrieval | no chat; consolidation proposes archive candidates only |

Embedding failures degrade search to BM25-only. A write without a working
embedding backend stores the fact without `embedding` and reports a warning;
`backfill` fills it later.

## Retrieval

The port follows her.memory:

- CJK-aware tokenizer: `[a-zA-Z0-9_]+|[\u4e00-\u9fff]`.
- BM25 with `k1=1.5`, `b=0.75`, positive-score documents only.
- Dense cosine similarity weighted by energy:
  `0.5 + 0.5 * min(energy, energyMax) / energyMax`.
- Reciprocal Rank Fusion with `k=60`.
- Exact `[stable_key]` matches are returned first.
- `includeArchived` reads both files.
- Hits are appended to `retrieval_hits.jsonl`; maintenance applies the boost.

## Configuration

See [`configuration.md`](configuration.md). The defaults live in
`lib/config.js`; `config.json` is deep-merged over them and validated on load.
The API redacts API keys and never returns them.

## Tools

Four global tools: `memory_search`, `memory_add`, `memory_update`,
`memory_archive`. See [`memory-tools.md`](memory-tools.md) for schemas and
semantics.

## Skills

Four runtime skills: `her-memory`, `memory-recall`, `memory-capture`,
`memory-curation`. They are registered only when `ctx.skills` is available. The
skill bodies are English and instruct the model to reply in the user's
language. See [`memory-skills.md`](memory-skills.md).

A short `systemPrompt.section` points at the skills and tools without injecting
memory content.

## Settings page

`client.js` registers `settings.section` with `id: "her-memory"`, a localized
nav label thunk, `locale: "herMemory"`, and a component with four tabs.

All visible copy uses translation keys under the `herMemory` namespace, with
English and Simplified Chinese dictionaries. The page uses only theme tokens,
imports no Harness Client package, and does not use `dangerouslySetInnerHTML`.

## API

One route: `/plugins/dsh-her-memory/api`.

- `GET` returns redacted state.
- `POST` accepts `{ action, payload }` and dispatches to the engine.
- Same-origin checks; JSON content type for writes; a body-size cap.
- API failures return `{ ok:false, error:{ code, message, status, details } }`.

See [`settings-page.md`](settings-page.md) for the action list and state shape.

## Testing

- `node --test` for unit and integration tests.
- A local fake HTTP server implements both wire protocols.
- Tests cover store/atomicity/lock/corruption, config, retrieval, embeddings,
  lifecycle, consolidation, engine, tools, and API dispatch.
- `npm run check` runs `node --check` over every JavaScript source.
- Live verification uses the separate `her-memory-test` profile and port 3090.
- See [`testing-and-verification.md`](testing-and-verification.md) and
  [`verification-profile.md`](verification-profile.md).

## Milestones

1. Repository scaffolding and this plan.
2. Host core: paths, config, errors, util, store, retrieval, embeddings,
   lifecycle, version stamp, with tests.
3. Engine and consolidation, with tests.
4. Host integration: `index.js`, tools, skills, prompt, API, with tests.
5. Client settings page and locale resources.
6. Skill content and documentation.
7. Full test pass, syntax check, test-profile installation, and live verification.
8. Changelog update and user-approved commit.

## Acceptance criteria

- The plugin activates in the test profile without console errors.
- The settings sidebar shows a localized "Memory" entry; the page renders in
  English and Chinese and follows a language switch without reload.
- Config save, backend test, memory add/search/update/archive, maintenance,
  proposal review/execute/restore, export, and import work from the page.
- The four tools are visible to the agent and return structured results.
- The four skills appear in the skill catalog and load through the `skill` tool.
- `npm test` and `npm run check` pass.
- No files are written inside the plugin package at runtime.
- The existing `web` profile and the 3080 GUI are untouched.
