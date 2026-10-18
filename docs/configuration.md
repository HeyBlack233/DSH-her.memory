# Configuration

This document specifies the plugin's paths, `config.json` schema and defaults,
load and save semantics, the state file, backend presets, the plugin-row home
override, migration from an existing `her.memory` directory, and environment
precedence. `lib/config.js` and `lib/paths.js` implement these rules; the
storage layout they produce is described in [`data-model.md`](data-model.md).

## Paths

The plugin has one **home** directory. `config.json` and `state.json` always live
there. The **memory directory** (`memoryDir`) holds the corpus and everything
derived from it.

Home resolution, highest precedence first:

| Precedence | Source | Result |
|---|---|---|
| 1 | `config.home` in the Cordis plugin row | That absolute path, used as the plugin home |
| 2 | `$DSH_HOME` (empty or whitespace is ignored) | `$DSH_HOME/her-memory` |
| 3 | OS home | `~/.dsh/her-memory` |

The home is a startup concern. `loadConfig` deletes any `home` key found in
`config.json`, and `saveConfig` never persists one, so a hand-edited file cannot
move the directory away from the config file that was loaded. Changing the home
requires a profile reload.

`memoryDir` resolution, highest precedence first:

| Configured value | Result |
|---|---|
| Absolute path | That path |
| Relative path | Resolved against the plugin home |
| `null` or missing | `<home>/memories` |

There is no tilde expansion. `~/memories` is treated as the literal relative
path `~/memories`, so write `$HOME/...` or an absolute path instead.

```
<home>/
├── config.json
├── state.json
└── memories/                # default memoryDir
    ├── semantic_memories.jsonl
    ├── semantic_memories.jsonl.lock
    ├── archived_memories.jsonl
    ├── retrieval_hits.jsonl
    ├── semantic_version.json
    ├── _snapshots/
    └── _proposals/
```

The plugin never writes data inside its own package directory.

## Default configuration

A fresh `config.json` is created with exactly this content:

```json
{
  "schemaVersion": 1,
  "memoryDir": null,
  "backend": {
    "kind": "none",
    "embedding": {
      "url": "http://127.0.0.1:11434/api/embeddings",
      "model": "bge-m3",
      "apiKey": "",
      "timeoutMs": 15000
    },
    "chat": {
      "url": "http://127.0.0.1:11434/api/generate",
      "model": "qwen2.5:7b",
      "apiKey": "",
      "timeoutMs": 30000
    }
  },
  "search": {
    "defaultTopK": 8,
    "maxTopK": 20,
    "minSimilarity": 0,
    "maxResultChars": 6000,
    "rrfK": 60
  },
  "maintenance": {
    "autoRun": true,
    "intervalHours": 24,
    "energyInitial": 2.0,
    "energyDecay": 0.97,
    "energyMax": 5.0,
    "energyHitBoost": 0.2,
    "archiveDays": 90
  },
  "consolidation": {
    "triggerCount": 100,
    "triggerSizeMb": 2.5,
    "triggerDays": 30,
    "typeThresholds": {
      "preference": 0.9,
      "event": 0.8,
      "emotional": 0.75,
      "general": 0.8
    },
    "energyArchiveThreshold": 0.5,
    "llmJudge": true,
    "maxJudgePairs": 60
  },
  "ui": { "pageSize": 50 }
}
```

## Schema reference

Validation is strict. Each known field is checked against the rules below; an
invalid value rejects the whole configuration with `INVALID_INPUT` and a
`details.path` naming the field. There is no per-field fallback.

### Top level

| Key | Type | Default | Validation |
|---|---|---|---|
| `schemaVersion` | integer | `1` | Must equal `1`. |
| `memoryDir` | string \| null | `null` | `null`, or a non-empty string. Resolved as described in [Paths](#paths). |
| `home` | string | absent | Accepted by the validator but stripped from the file on load and save; only the plugin row sets it. |

### Backend

| Key | Type | Default | Validation |
|---|---|---|---|
| `backend.kind` | string enum | `none` | `ollama`, `llama-cpp`, `openai-compatible`, or `none`. |
| `backend.embedding.url` | string | `http://127.0.0.1:11434/api/embeddings` | Non-empty when `kind` is not `none`; may be empty when `kind` is `none`. |
| `backend.embedding.model` | string | `bge-m3` | Same emptiness rule as `url`. |
| `backend.embedding.apiKey` | string | `""` | Any string, including empty. |
| `backend.embedding.timeoutMs` | number | `15000` | Finite and at least `1`. No upper bound. |
| `backend.chat.url` | string | `http://127.0.0.1:11434/api/generate` | Non-empty when `kind` is not `none`; may be empty when `kind` is `none`. |
| `backend.chat.model` | string | `qwen2.5:7b` | Same emptiness rule as `url`. |
| `backend.chat.apiKey` | string | `""` | Any string, including empty. |
| `backend.chat.timeoutMs` | number | `30000` | Finite and at least `1`. No upper bound. |

Allowing empty URL and model under `kind: "none"` lets the settings page clear
fields without making the configuration unsavable.

### Search

| Key | Type | Default | Validation |
|---|---|---|---|
| `search.defaultTopK` | integer | `8` | At least `1` and not greater than `search.maxTopK`. |
| `search.maxTopK` | integer | `20` | `1`–`10000`. |
| `search.minSimilarity` | number | `0` | `0`–`1`. Compared against the energy-weighted dense score; see [`retrieval.md`](retrieval.md). |
| `search.maxResultChars` | integer | `6000` | At least `1`. |
| `search.rrfK` | number | `60` | At least `1`. |

### Maintenance

| Key | Type | Default | Validation |
|---|---|---|---|
| `maintenance.autoRun` | boolean | `true` | — |
| `maintenance.intervalHours` | number | `24` | At least `1`. |
| `maintenance.energyInitial` | number | `2.0` | At least `0`. |
| `maintenance.energyDecay` | number | `0.97` | Greater than `0` and at most `1`. |
| `maintenance.energyMax` | number | `5.0` | Greater than `0`. |
| `maintenance.energyHitBoost` | number | `0.2` | At least `0`. |
| `maintenance.archiveDays` | number | `90` | At least `0`. |

### Consolidation

| Key | Type | Default | Validation |
|---|---|---|---|
| `consolidation.triggerCount` | integer | `100` | At least `1`. |
| `consolidation.triggerSizeMb` | number | `2.5` | At least `0`. |
| `consolidation.triggerDays` | number | `30` | At least `0`. |
| `consolidation.typeThresholds` | object | four entries | Every entry must be a number in `0`–`1`. Unknown keys are preserved and validated the same way. |
| `consolidation.energyArchiveThreshold` | number | `0.5` | At least `0`. |
| `consolidation.llmJudge` | boolean | `true` | — |
| `consolidation.maxJudgePairs` | integer | `60` | At least `1`. |

### UI

| Key | Type | Default | Validation |
|---|---|---|---|
| `ui.pageSize` | integer | `50` | `1`–`10000`. |

## Load semantics

`loadConfig({ home, env })`:

1. Resolve the home: explicit `home` option, `$DSH_HOME`, then `~/.dsh`.
2. Read `<home>/config.json`.
   - Missing: clone the defaults, validate them, write them as indented JSON
     with mode `0600`, and return them.
   - Unreadable for another reason: `STORE_IO`.
3. Parse the file. Invalid JSON or a non-object document fails with
   `INVALID_INPUT` (`details.path: "config.json"`).
4. Delete a `home` key if present.
5. Deep-merge the file over the defaults: plain objects merge recursively,
   arrays and scalars replace, `undefined` patch values are ignored. Unknown
   keys are preserved in memory and on the next save.
6. Validate the merged result. Any violation throws `INVALID_INPUT` with
   `details.path` and `details.reason`.

A failed load is an initialization failure. The host plugin logs it, and the
settings API reports that the engine failed to initialize rather than serving a
partially configured store.

## Save semantics

`saveConfig(patch, { home, env })`:

1. Load the current configuration from the same home.
2. Deep-merge `patch` over it.
3. Strip `home` again.
4. Validate the merged configuration.
5. Atomically write `<home>/config.json` as indented JSON with mode `0600`.
6. Return the validated configuration tagged with its home.

Saving is live: the engine keeps the returned configuration, so a save does not
require a plugin reload. Saves are last-writer-wins; there is no separate config
lock and no merge across processes — the atomic rename prevents a torn file, not
a lost update.

### Redaction and API round-trips

- `redactConfig` returns a deep copy with each endpoint's `apiKey` removed and
  replaced by a boolean `apiKeySet`. The API never returns a key.
- The API additionally masks any secret-shaped key anywhere in a response as
  `"[redacted]"`, and removes `apiKeySet` from an incoming config patch before
  merging.
- Because a patch is merged, omitting `apiKey` leaves the stored key unchanged.
  Sending `apiKey: ""` clears it.

## State file

`state.json` is a small, derived file. Its default shape is:

```json
{
  "schemaVersion": 1,
  "lastMaintenance": null,
  "lastProposalAt": null,
  "lastBackfillAt": null,
  "lastError": null
}
```

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | integer | State shape version; currently `1`. |
| `lastMaintenance` | string \| null | ISO timestamp of the last completed maintenance run. |
| `lastProposalAt` | string \| null | ISO timestamp of the last generated consolidation proposal. |
| `lastBackfillAt` | string \| null | ISO timestamp of the last embedding backfill. |
| `lastError` | object \| null | Last recorded initialization or maintenance error. |

- `loadState` tolerates a missing or corrupt file by falling back to the
  defaults; a malformed state file never blocks startup.
- `saveState` deep-merges the value over the defaults and writes it atomically
  with mode `0600`.
- **Auto-maintenance check.** The host schedules one check three seconds after
  activation. The engine compares `lastMaintenance` with
  `maintenance.intervalHours`; when the interval has elapsed and
  `maintenance.autoRun` is true, it runs maintenance and updates
  `lastMaintenance`. With `autoRun: false`, maintenance runs only from the
  settings page.
- Deleting `state.json` is safe: it is rebuilt with the defaults on the next
  load, which makes the next check consider maintenance due.

## Backend presets

Presets are the values the settings page offers when the user picks a backend
kind. Loading a configuration never rewrites URLs or models, so every value in
`config.json` is authoritative.

| Kind | Embedding URL | Embedding model | Chat URL | Chat model |
|---|---|---|---|---|
| `ollama` | `http://127.0.0.1:11434/api/embeddings` | `bge-m3` | `http://127.0.0.1:11434/api/generate` | `qwen2.5:7b` |
| `llama-cpp` | `http://127.0.0.1:8080/v1/embeddings` | `bge-m3` | `http://127.0.0.1:8081/v1/chat/completions` | `qwen2.5:7b` |
| `openai-compatible` | `http://127.0.0.1:8000/v1/embeddings` | `bge-m3` | `http://127.0.0.1:8000/v1/chat/completions` | `qwen2.5:7b` |
| `none` | retained but unused | retained but unused | retained but unused | retained but unused |

- `llama-cpp` uses two ports because `llama-server` serves one model per
  process.
- `openai-compatible` is any server speaking the OpenAI wire shape. The preset
  points at a local server; for a hosted provider, change the URLs and models
  and set `apiKey`.
- `none` makes no embedding or chat request. Search is keyword-only, and
  consolidation proposes archive candidates without an LLM judge.
- Switching kind does not migrate embeddings. After a switch, run
  `backfill --all` so the corpus uses one vector space.

## Plugin-row home override

The bundle patch inserts the `her-memory` row. Only `home` can be set there:

```yaml
- insert:
    - id: her-memory
      name: '@local/dsh-her-memory'
      config:
        home: /absolute/path/to/her-memory
```

`home` selects where `config.json`, `state.json`, and the default `memories/`
directory live. It does not override `memoryDir`; that remains a `config.json`
value resolved relative to the selected home. The row config is not written into
`config.json`, and changing it takes effect on the next profile start.

## Migrating from an existing her.memory directory

1. Stop any cron job or scheduled task that runs the `her.memory` Python
   scripts against the directory.
2. Set `memoryDir` to that directory — the one that contains
   `semantic_memories.jsonl` — either absolutely or relative to the plugin home.
   No import step is needed: file names, record fields, the hit log, and the
   version stamp are compatible.
3. Restart the profile. The plugin reads the existing corpus, reuses stored
   embeddings, and creates `config.json`/`state.json` in its own home.
4. If the embedding backend, model, or runtime differs from the one that
   produced the stored vectors, run `backfill --all` from the settings page.
5. The first content-changing write recomputes `semantic_version.json`. Until
   then, the stored stamp reflects the pre-migration corpus.
6. Do not run the Python tools and the plugin against the same directory
   concurrently. The lock file name is shared but the protocols differ, and the
   Python tools degrade to unlocked operation on Unix.

To keep the original untouched, copy the directory first and point `memoryDir`
at the copy.

## Environment variables and precedence

| Variable | Effect |
|---|---|
| `DSH_HOME` | Selects the DeepSeek Harness home; the plugin home becomes `$DSH_HOME/her-memory`. Empty or whitespace-only values are ignored. |
| `HOME` / `USERPROFILE` | Only indirectly, through the OS home used when `DSH_HOME` is unset. |

There are no plugin-specific environment variables. `her.memory`'s
`MEMORY_BACKEND`, `OLLAMA_*`, and `LLAMA_CPP_*` variables are not read.

Effective precedence, highest first:

1. Plugin-row `home` for the plugin home.
2. `$DSH_HOME` for the plugin home.
3. `~/.dsh` for the plugin home.
4. `memoryDir` in `config.json` for the memory directory.
5. `<home>/memories` when `memoryDir` is unset.
6. Built-in defaults for every other setting.

## Current limitations

- One configuration per plugin home. There are no per-project or per-agent
  configuration profiles.
- `schemaVersion` is `1` only; there is no migration path from a future schema.
- Validation is all-or-nothing: one invalid field prevents the configuration
  from loading. Invalid files must be fixed by hand or removed (a removed file
  is recreated with defaults, and its custom values are lost).
- `home` changes require a profile reload; `memoryDir` changes take effect on
  the next engine initialization.
- Concurrent saves from two processes are last-writer-wins.
- API keys are stored in plaintext `config.json`, protected only by file mode.
- Unknown keys are preserved but ignored; a typo silently keeps the default.
- If a relative `memoryDir` names a directory that does not exist, the plugin
  creates it, which can hide a mistyped path.
