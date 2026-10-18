# Architecture

This document describes the shape of the plugin: its components, the data flow
for each caller, the DeepSeek Harness (DSH) extension points it uses, and the
boundary between this project and `her.memory`. Storage mechanics are specified
in [`data-model.md`](data-model.md), ranking in [`retrieval.md`](retrieval.md),
configuration in [`configuration.md`](configuration.md), and the page, tools,
skills, and consolidation workflow in their own documents.

Details that [`implementation-plan.md`](implementation-plan.md) leaves open are
specified here as the intended design.

## Purpose

The plugin gives DSH sessions one persistent, human-readable companion memory:

- A single JSONL memory store shared by every session in a DSH profile.
- Model access through explicit tools, with no automatic prompt injection.
- Hybrid keyword + embedding recall, energy-based lifecycle, supersede chains,
  and proposal-based consolidation.
- A localized settings page in the DSH Web GUI for inspecting and curating
  memory without editing files by hand.

The plugin is a native JavaScript port of `her.memory`. It reads and writes the
same JSONL files, so an existing `her.memory` directory can be used directly.

## Non-goals

| Non-goal | Reason |
|---|---|
| Per-turn automatic recall injection | Recall is model-initiated; see [Why there is no auto-recall](#why-there-is-no-auto-recall). |
| Automatic per-turn memory extraction | Capture is explicit through tools and skills; no background LLM pass observes conversations. |
| A vector database or search service | The corpus is small enough for an in-memory index built per query. |
| A Python runtime or `her.memory` scripts at runtime | The port is pure JavaScript; the reference implementation is a design source only. |
| Multi-user or multi-tenant isolation | One store, one owner, one OS account. |
| Cloud sync, hosted embeddings, or remote storage | Memory data stays on the machine that owns it by default. |
| Editing memory outside the proposal workflow | Consolidation proposes; the owner approves; snapshots allow restore. |
| Writing anything into the plugin package directory | All runtime data lives under the plugin home. |
| Encryption at rest | Files are protected by OS permissions, not a plugin-managed key. |

## Components

```
┌────────────────────────────── Host process ──────────────────────────────┐
│  index.js (plugin entry)                                                  │
│    ├─ lib/engine.js  ── one shared engine per plugin instance            │
│    │    ├─ lib/config.js, lib/paths.js, lib/errors.js                    │
│    │    ├─ lib/store.js  ── JSONL, lock, atomic write, snapshots, hits   │
│    │    ├─ lib/retrieval.js  ── BM25 + dense + RRF                      │
│    │    ├─ lib/embeddings.js ── backend adapters                         │
│    │    ├─ lib/lifecycle.js  ── add/update/archive, maintenance          │
│    │    ├─ lib/version-stamp.js                                      │
│    │    └─ lib/consolidation.js                                      │
│    ├─ lib/tools.js    ── four model tools                                │
│    ├─ lib/skills.js   ── four runtime skills                             │
│    ├─ lib/prompt.js   ── short system-prompt section                     │
│    └─ lib/api.js      ── /plugins/dsh-her-memory/api                     │
│                                                                          │
│  Browser                                                                 │
│    client.js  ── settings.section page; talks only to the host API       │
└──────────────────────────────────────────────────────────────────────────┘
```

| Component | Responsibility |
|---|---|
| `index.js` | Host plugin entry: resolves the plugin home, creates the engine, registers tools, skills, the prompt section, the web API, and the optional `herMemory` service. |
| `lib/engine.js` | The single facade every caller uses. Owns config, state, and backend clients; serializes engine-level operations; exposes the methods listed in the plan's engine contract. |
| `lib/store.js` | JSONL reading and writing, cross-process lock, atomic replacement, snapshots, hit-log append and drain. The only module that touches memory files. |
| `lib/retrieval.js` | Pure ranking functions: tokenizer, BM25, energy-weighted cosine, reciprocal rank fusion, stable-key priority. No I/O. |
| `lib/embeddings.js` | Backend adapters for `ollama`, `llama-cpp`, `openai-compatible`, and `none`; request shapes, timeouts, error classification, dimension reporting. |
| `lib/lifecycle.js` | Write-path semantics: add, update, archive, maintenance (decay, hit settlement, physical archive), backfill, stamp refresh. |
| `lib/version-stamp.js` | Content hash over both JSONL files and the `semantic_version.json` payload. |
| `lib/consolidation.js` | Proposal generation, review data, execution, restore, permanent delete. See [`consolidation.md`](consolidation.md). |
| `lib/config.js` | Defaults, deep merge, validation, redacted views, save, and the state file. See [`configuration.md`](configuration.md). |
| `lib/paths.js` | Harness home resolution, plugin home, memory directory, directory creation, permission masks. |
| `lib/errors.js` | `HermemoryError` with `code`, `message`, `status`, `details`, and the stable code list. |
| `lib/util.js` | ID generation, local timestamps, cosine similarity, tokenizer helpers, small pure utilities. |
| `lib/tools.js` | The four model tools. See [`memory-tools.md`](memory-tools.md). |
| `lib/skills.js` | Loads `skills/*.md` and registers them when the skill service exists. See [`memory-skills.md`](memory-skills.md). |
| `lib/prompt.js` | The short `systemPrompt.section` pointer. It contains no memory content. |
| `lib/api.js` | The same-origin JSON route used by the settings page. See [`settings-page.md`](settings-page.md). |
| `client.js` | Browser entry that registers the `settings.section` page with four tabs. |
| `locale/en.json`, `locale/zh.json` | Plugin inventory metadata (`meta.title`, `meta.description`). The UI dictionary lives in `client.js` under the `herMemory` namespace. See [`localization.md`](localization.md). |
| `cordis.patch.yml` | Bundle patch that inserts the `her-memory` plugin row. |
| `test/` | Unit and integration tests; `fake-backend.js` speaks both wire protocols. See [`testing-and-verification.md`](testing-and-verification.md). |

## Data flow

### Model recall

```
model → skill (memory-recall) → tool memory_search → tools.js
      → engine.search → store.readCorpus → retrieval.rank
      → store.logHits → tool result → model context
```

1. The model loads the `memory-recall` skill (or already knows the tools) and
   calls `memory_search` with a query and optional filters.
2. `lib/tools.js` validates the arguments against the tool schema and calls the
   engine method; the engine serves the call once initialization has settled.
3. `engine.search` loads the corpus from `semantic_memories.jsonl` and, when
   `includeArchived` is set, `archived_memories.jsonl`. Reads are lock-free;
   atomic replacement guarantees a complete file. The store keeps a parsed
   copy of each file keyed by its mtime and size, so an unchanged corpus is not
   parsed again.
4. `lib/retrieval.js` applies filters, extracts a bracketed stable key, embeds
   the query through the configured backend, computes BM25 and dense rankings,
   fuses them, and returns at most `topK` results.
5. The engine appends `{id, ts}` lines for the returned entries to
   `retrieval_hits.jsonl` on a best-effort basis. A failed hit write never fails
   the search; it produces a warning.
6. The tool returns the result object and any warnings. The model decides how
   to use it. Nothing is injected into the conversation by the plugin.

### Model write

1. The model calls `memory_add`, `memory_update`, or `memory_archive`.
2. `lib/tools.js` normalizes `type`, `category`, `eventDate`, and `origin`
   provenance, then calls the matching engine method.
3. The engine validates the input (`INVALID_INPUT`) and, when `dedupe` is true
   and a `projectKey` is present, checks the write-time dedupe gate for an
   existing record with the same `projectKey` and `category`. A hit is not an
   error: the result is `{ added: false, duplicateId }` and the existing record
   is left untouched. Without a `projectKey`, `dedupe` has no effect.
4. The engine requests an embedding when the backend is usable.
5. `lib/lifecycle.js` acquires the store lock, loads the affected file, applies
   the change, and rewrites the file atomically:
   - `add` is a read-modify-write append: it loads the active file, pushes the
     new record, and atomically replaces the file;
   - `update` and `archive` rewrite the active file the same way.
   The content stamp is refreshed after the write.
6. The engine returns the stored record. If the embedding backend failed, the
   record is stored without `embedding` and the result carries a warning;
   `backfill` fills it later.

Every write goes through the engine. Tools, the API, maintenance, and
consolidation never write files directly.

### Settings-page actions

```
Browser settings page → GET  /plugins/dsh-her-memory/api → redacted state
                      → POST /plugins/dsh-her-memory/api {action, payload}
                      → api.js → engine.<action> → JSON result
```

- `GET` returns the redacted state: config (without API keys), memory counts,
  pending-compaction count, stamp summary, proposal list, state timestamps,
  registered skills, and tool names. It never returns raw file contents.
- `POST` requires a same-origin request, the JSON content type, and a body of
  at most 25 MiB. It dispatches one action by name to an allow-listed engine
  method. The action list and the exact state shape belong to
  [`settings-page.md`](settings-page.md).
- Errors use the envelope `{ ok: false, error: { code, message, status,
  details } }`. Success responses use `{ ok: true, value: ... }`.
- The client never reads or writes the filesystem. Everything it shows is a
  projection the host computed.

### Maintenance and consolidation

- Activation schedules one maintenance check three seconds after the plugin
  starts (`ctx.setTimeout`, `ctx.timeout`, or an unref'd `setTimeout`). The
  check calls `engine.maybeAutoMaintain()` when available; the engine compares
  `state.lastMaintenance` with `maintenance.intervalHours` and starts a run only
  when it is due and `maintenance.autoRun` is true.
- A maintenance run settles the hit log, decays energy, physically moves
  archived-marked records to `archived_memories.jsonl`, refreshes the stamp,
  and updates `lastMaintenance`. See [`data-model.md`](data-model.md).
- Consolidation is always an explicit proposal: `propose` writes a proposal
  document under `_proposals/`; `executeProposal` takes a snapshot first;
  `restoreProposal` reverts from it. See [`consolidation.md`](consolidation.md).

## Extension points

| Extension point | Registered content | Service | Disposal |
|---|---|---|---|
| `ctx.tools.register` | `memory_search`, `memory_add`, `memory_update`, `memory_archive` | Optional (`tools`) | Each registration's disposer unregisters the tool. |
| `ctx.skills.register` | Four runtime skills loaded from `skills/*.md` | Optional (`skills`) | Registration is skipped when the service is absent; the disposer unregisters each skill. |
| `ctx.systemPrompt.section` | One short section named `her-memory:availability`, order `100`, pointing at the tools and skills | Optional (`systemPrompt`) | The section disposer removes the pointer. |
| `ctx.webServer.register` | One exact route `/plugins/dsh-her-memory/api` | Optional (`webServer`) | The route disposer removes the handler. |
| `settings.section` (client) | Nav entry `her-memory` with a localized label thunk and the four-tab page | Client slot | The client plugin's registration is disposed with the browser plugin. |
| `ctx.provide('herMemory')` | Optional service exposing `engine.api ?? engine` to other plugins | Optional | The provide disposer withdraws the service. |

Notes:

- No injected service is a hard dependency. `apply()` uses `ctx.inject` for
  `tools`, `skills`, `systemPrompt`, and `webServer`, so a plain host
  composition activates the plugin with fewer surfaces instead of failing.
- The prompt section is a pointer only: it names the skills and tools and says
  that memory text is untrusted data. It never contains memory content, so it
  cannot leak stored facts into a session that did not ask for them.
- The client package declares `@deepseek-ai/dsh-client-locale` and
  `@deepseek-ai/dsh-client-ui-settings` as client injects in `package.json`, so
  the slot and locale services are present before `client.js` runs.
- No other extension point is used. The plugin does not register commands,
  message hooks, middleware, or a conversation renderer.
- `ctx.provide('herMemory')` is available for future integrations. No current
  code depends on it, and the plugin must work when nothing consumes it.

## Ownership and disposal

- **One engine per plugin instance.** `index.js` creates the engine during
  `apply()`, starts initialization without blocking activation, and exposes
  `engine.ready` for initialization errors. Registrations happen immediately.
- **Effect-owned registrations.** Every registration is wrapped in `ctx.effect`;
  unloading the plugin removes the tools, skills, prompt section, route, and
  optional service. The one-shot automatic-maintenance timer is either owned by
  the host scheduler or an unref'd `setTimeout` cleared through an effect, so it
  cannot keep the process alive or fire after disposal.
- **No persistent handles.** The store holds no open file handle outside a lock
  transaction; the lock is released in a `finally` block, and only if its token
  still matches the holder's. Backend calls have no retained connections.
- **Single writer per memory directory.** The in-process mutex plus the lock
  file in `store.js` serialize writes. Several DSH processes may share one
  memory directory; they coordinate through the lock, and readers see whole
  files because every replacement is atomic. See [`data-model.md`](data-model.md).
- **Live configuration.** `saveConfig` rewrites `config.json` and updates the
  engine's config in memory; no plugin reload is needed. Changing the plugin
  home through the Cordis row is a profile-level change and requires a reload.
- **Per-process parse cache.** The store caches parsed entries per file keyed by
  mtime and size. A write from another process changes both, so the next read
  re-parses; there is no stale cross-process view.

## Why there is no auto-recall

Recall is deliberately a tool call, not an injection:

1. **Context cost.** Injecting several memory entries into every turn spends
   context on facts that most turns do not need, and it pushes out the material
   the user actually asked about.
2. **Privacy.** Injected memory text becomes part of the transcript, logs, and
   any exported conversation. A tool call returns memory only to the turn that
   asked, and only when the model decided it was relevant.
3. **Control.** The quality bar for companion memory is relevance, not
   recency. The model has the conversation and can phrase the query; a fixed
   pre-turn query would guess badly and teach the user to ignore the results.

The plugin therefore ships discovery aids instead: a short system-prompt
pointer, four skills, and four tools. The model chooses when to look and what to
write.

## File and module map

| Path | Role |
|---|---|
| `index.js` | Host plugin entry and activation wiring. |
| `client.js` | Browser plugin entry and `settings.section` registration. |
| `cordis.patch.yml` | Bundle patch inserting the `her-memory` row. |
| `package.json` | Package metadata, `dsh` bundle and client metadata, scripts. |
| `icon.svg` | Settings section icon. |
| `locale/en.json`, `locale/zh.json` | Plugin inventory metadata; the UI dictionary is embedded in the client bundle. |
| `lib/paths.js` | Home and directory resolution. |
| `lib/config.js` | Config defaults, load/save/validate/redact, state file. |
| `lib/errors.js` | Typed errors and stable codes. |
| `lib/util.js` | IDs, timestamps, cosine, tokenizer helpers. |
| `lib/store.js` | JSONL I/O, lock, atomic write, snapshots, hit log. |
| `lib/retrieval.js` | BM25, energy-weighted cosine, RRF, stable-key priority. |
| `lib/embeddings.js` | Backend adapters and dimension reporting. |
| `lib/lifecycle.js` | Write-path semantics, maintenance, backfill. |
| `lib/version-stamp.js` | Content stamp. |
| `lib/consolidation.js` | Proposals, execution, restore, delete. |
| `lib/engine.js` | Engine facade. |
| `lib/tools.js` | Four tool definitions. |
| `lib/skills.js` | Skill registration. |
| `lib/prompt.js` | System-prompt pointer. |
| `lib/api.js` | Settings-page API route. |
| `skills/*.md` | Skill bodies. |
| `test/*.test.js`, `test/helpers.js`, `test/fake-backend.js` | Test suite and fake backend. |

## Relationship to her.memory

The plugin is a port, not a wrapper. It reimplements the storage and retrieval
model in JavaScript and never invokes the reference Python scripts.

| Concern | Relationship |
|---|---|
| Record schema | Same core fields and optional chain fields. This plugin adds optional `origin` provenance (`source`, `sessionId`, `toolCallId`). |
| Files | Same names and directory roles (`semantic_memories.jsonl`, `archived_memories.jsonl`, `retrieval_hits.jsonl`, `semantic_version.json`), so either implementation can read the other's directory. |
| Retrieval | Same tokenizer pattern, BM25 parameters, energy weighting, RRF constant, and stable-key priority. Tokens are lowercased and `minSimilarity` filters the energy-weighted dense score; both choices are stated in [`retrieval.md`](retrieval.md). |
| Version stamp | Same algorithm, field order, both-file scan, and snake_case payload. |
| Hit log | Same `{id, ts}` lines, so a directory can move between implementations without rewriting hits. |
| Locking | Different lock protocol: an exclusive-create `semantic_memories.jsonl.lock` with a 120-second stale timeout and dead-PID detection. `her.memory` does not honor it, so do not run both implementations against one directory at the same time. |
| Configuration | Different surface: `config.json` and the settings page instead of environment variables and CLI flags. See [`configuration.md`](configuration.md). |
| Consolidation | Same proposal/review/execute/restore model, implemented in `lib/consolidation.js`. |
| Runtime | No Python, no `numpy`, no `requests`; Node.js 22 or newer. |

## Current limitations

- No ambient recall: a session that never calls `memory_search` sees no memory.
- No vector database or ANN index; each query builds a BM25 index over the
  filtered candidates. Parsed JSONL is cached per file by mtime and size. See
  [`retrieval.md`](retrieval.md) for scale notes.
- Maintenance is not a scheduler: one check runs shortly after activation, and
  the engine may also check on demand. A process that stays alive for days
  without any check does not decay or archive anything.
- One store per plugin home. There is no per-project or per-agent partitioning.
- Snapshots are not pruned automatically; they accumulate until removed by hand.
- Embeddings are stored inline in the JSONL, so the active file grows roughly
  with the vector dimension per record.
- The plugin does not synchronize files between machines or checkpoints the
  store beyond the snapshots it takes before destructive operations.
