# Settings Page

The plugin contributes one page to the DSH settings panel. It is registered on
the `settings.section` slot as:

```js
ctx.slots.register({
  name: "settings.section",
  id: "her-memory",
  order: 30,
  label: () => ctx.locale.bind("herMemory")("nav.label"),
  locale: "herMemory",
}, MemorySettingsPage);
```

`id: "her-memory"` places a new section beside the shipped entries instead of
replacing one. The label thunk is re-read on every projection, so the sidebar
entry follows a language switch without re-registration. The `locale` option
injects the page's `t` reader; the page body re-renders on locale changes.

## Page structure

The page is a full-width column inside the settings content area. It has a
header (title, subtitle, backend status pill, Refresh) and four in-page tabs.
Tabs use `role="tablist"`, `role="tab"` with `aria-selected`, and
`role="tabpanel"` with `aria-labelledby`; Left/Right/Home/End move the active
tab. There are no modals: add/edit forms, archive confirmation, delete
confirmation, and proposal review are inline panels.

### Overview

- Status pill: `none`, `unknown`, `ready`, or `degraded`; it reflects
  `status.backend`, with `config.backend.kind` deciding "not configured".
- Stats grid: active, archived, pending compaction, total, active-file size,
  version short id, last maintenance.
- Backend card: kind, embedding model/URL, LLM model/URL, last test result.
- Quick actions: Test connection, Run maintenance, Backfill embeddings,
  Recompute stamp.
- Empty state when the store has no active memories: explain that the model
  uses the her-memory skills and the four memory tools.
- A last-error banner shows the localized error text; for validation errors it
  also shows the localized field detail, never a raw server message.

### Memories

- Toolbar: query input (Enter searches), Search, category select built from
  `stats.categories`, type select, Include archived checkbox, Add memory.
- Inline add form: text (required), type, category with datalist, event date,
  project key, dedupe. Inline edit form: text, type, category, event date. Edit
  uses `memory_update` and explains that the old version is archived and linked.
- Result cards show the memory text with whitespace preserved, type/category
  badges, energy, last hit, archived badge, and a truncated id with a copy
  button. Actions: Edit, Archive (inline confirmation), Delete permanently
  (user-only, two-step confirmation).
- Pagination uses `memories.list` for browsing (`offset`, `limit`,
  `ui.pageSize`) and `memories.search` for a query (top results, no paging).
- Empty, loading, and error states are inline and localized.

### Curation

- Maintenance card: energy decay, archive days, max energy, hit boost; Save;
  Run maintenance; Backfill missing embeddings; Backfill all embeddings;
  Recompute stamp; pending-compaction count and "Compact now" (both plain
  maintenance and compaction call `maintenance.run` with `action: "maintain"`).
- Consolidation card: trigger count/size/days, per-type similarity thresholds,
  LLM judge toggle; Generate proposal.
- Proposal list: id, generated time, status, counts. Selecting one loads the
  detail.
- Proposal detail: trigger reason, current stats, merge groups (checkbox,
  editable merged text prefilled with `proposed_text`, member list with text,
  type, energy), archive candidates (checkbox, reason), skill candidates
  (read-only). Actions: Approve & execute selected (inline confirmation),
  Restore snapshot (only when status is `executed`; confirmation), Refresh.
- Execution and restore results are shown inline. Empty selection is rejected
  by the host before any snapshot is taken.
- All curation actions are user-only. The model has no tool for them.

### Settings

- Connection: backend kind (`ollama`, `llama-cpp`, `openai-compatible`, `none`),
  embedding URL/model/timeout, LLM URL/model/timeout, API key fields with
  "unchanged" placeholders and a Clear key checkbox. A preset button fills the
  default URLs/models for the selected kind. Test connection; Save.
- Search defaults: `defaultTopK`, `maxTopK`, `minSimilarity`,
  `maxResultChars`, `rrfK`; Save.
- Storage: plugin home (read-only), `memoryDir` (editable), derived active,
  archive, hit, version, snapshots, and proposals paths (read-only with copy
  buttons), file size. Export downloads active + archived JSONL. Import reads a
  JSONL file, previews the non-empty line count, confirms, and reports imported
  / skipped / invalid / filled counts. An import can request embedding backfill.
- About: plugin version, link to her.memory, license/attribution note, the
  registered skill names and descriptions, the four tool names, and the memory
  format.
- Each card has its own Save button and inline "saved" or error status.

## Host API

One exact route: `/plugins/dsh-her-memory/api`.

- `GET` returns the redacted state.
- `POST` takes `{ action, payload }`.
- Success: `{ "ok": true, "value": ... }`.
- Failure: `{ "ok": false, "error": { "code", "message", "status", "details" } }`.

The handler accepts only same-origin requests: `Sec-Fetch-Site: cross-site` is
rejected, and a present `Origin` must match the `Host` header. POSTs require
`content-type: application/json`. The body is capped at 25 MiB. There is no
separate auth token; the DSH web server is the trust boundary and binds
localhost by default.

### Actions

| Action | Payload | Result |
|---|---|---|
| `state` | `{}` | Full state. |
| `config.save` | Partial config patch | Fresh state. `apiKeySet` markers are stripped; `apiKey` strings are the only secret fields. Omit a key to keep it; send `""` to clear it. |
| `backend.test` | `{ chat: true }` | `{ embedding: { ok, latencyMs, dimensions, model }, chat: { ok, latencyMs, model } }`; `chat: false` skips the LLM probe; the request and response keys keep the name `chat`. |
| `memories.search` | `{ query, topK?, category?, type?, includeArchived? }` | `{ query, retrievalMode, results, warnings }`. Settings searches do not log retrieval hits. |
| `memories.list` | `{ query?, category?, type?, includeArchived?, offset?, limit? }` | `{ items, total, offset, limit }`. |
| `memories.add` | `{ text, type?, category?, eventDate?, projectKey?, dedupe? }` | `{ added, id, duplicateId, hasEmbedding, warnings }`. |
| `memories.update` | `{ id, text?, type?, category?, eventDate? }` | `{ updated, oldId, newId, hasEmbedding }`. |
| `memories.archive` | `{ id, reason? }` | `{ archived, id, alreadyArchived? }`. |
| `memories.delete` | `{ id, confirm: true }` | `{ deleted: true, id }`. User-only permanent delete; the host snapshots first. |
| `maintenance.run` | `{ action: "maintain" \| "backfill" \| "backfillAll" \| "stamp" }` | Maintenance counts, backfill counts, or the stamp. `maintain` also moves pending archived records to the archive file. |
| `consolidation.propose` | `{}` | The proposal. |
| `consolidation.list` | `{}` | Proposal summaries. |
| `consolidation.get` | `{ id }` | The full proposal. |
| `consolidation.execute` | `{ id, groups, archiveIds, mergedTexts }` | `{ merged_count, archived_count, backup_path, proposal_id }`. |
| `consolidation.restore` | `{ id }` | `{ restored: true, proposal_id }`. |
| `data.export` | `{}` | `{ active, archived, version }`, where the first two are JSONL text. |
| `data.import` | `{ jsonl, backfill? }` | `{ imported, skipped, invalid, filled }`. |

Unknown actions return `400 INVALID_INPUT`. A request whose body exceeds the cap
returns `413 INVALID_INPUT`.

### State shape

```json
{
  "plugin": { "name": "@local/dsh-her-memory", "version": "0.1.0" },
  "config": {
    "schemaVersion": 1,
    "memoryDir": "/home/user/.dsh/her-memory/memories",
    "backend": {
      "kind": "none",
      "embedding": { "url": "http://127.0.0.1:11434/api/embeddings", "model": "bge-m3", "timeoutMs": 15000, "apiKeySet": false },
      "chat": { "url": "http://127.0.0.1:11434/api/generate", "model": "qwen2.5:7b", "timeoutMs": 30000, "apiKeySet": false }
    },
    "search": { "defaultTopK": 8, "maxTopK": 20, "minSimilarity": 0, "maxResultChars": 6000, "rrfK": 60 },
    "maintenance": { "autoRun": true, "intervalHours": 24, "energyInitial": 2, "energyDecay": 0.97, "energyMax": 5, "energyHitBoost": 0.2, "archiveDays": 90 },
    "consolidation": { "triggerCount": 100, "triggerSizeMb": 2.5, "triggerDays": 30, "typeThresholds": { "preference": 0.9, "event": 0.8, "emotional": 0.75, "general": 0.8 }, "energyArchiveThreshold": 0.5, "llmJudge": true, "maxJudgePairs": 60 },
    "ui": { "pageSize": 50 }
  },
  "paths": {
    "home": "...", "configFile": "...", "memoryDir": "...",
    "activeFile": "...", "archiveFile": "...", "hitFile": "...",
    "versionFile": "...", "snapshotsDir": "...", "proposalsDir": "..."
  },
  "stats": {
    "active": 0, "archived": 0, "pendingCompaction": 0, "total": 0,
    "fileSizeBytes": 0, "versionShort": "", "versionBuiltAt": "",
    "corruptLines": 0, "categories": [], "types": []
  },
  "status": {
    "backend": "none",
    "backendKind": "none",
    "embeddingModel": "bge-m3",
    "chatModel": "qwen2.5:7b",
    "lastMaintenance": null,
    "lastBackfill": null,
    "lastProposal": null,
    "lastError": null
  },
  "skills": [{ "name": "her-memory", "description": "..." }],
  "tools": ["memory_search", "memory_add", "memory_update", "memory_archive"],
  "capabilities": { "skills": true, "prompt": true, "webApi": true }
}
```

`config` is always redacted: raw `apiKey` values never cross the API boundary.
`status.backend` is a string (`none`, `unknown`, `ready`, `degraded`); a
configured backend starts `unknown` and becomes `ready` or `degraded` after a
probe or a failed embedding path.

## Error codes

The client maps stable codes to localized sentences. For `INVALID_INPUT` it
also renders a localized field detail derived from `details.path` and
`details.reason`; other codes render the localized sentence alone. Raw server
messages never appear in the page, and an unknown code falls back to
`errors.UNKNOWN`. Known codes: `INVALID_INPUT`, `STORE_LOCKED`,
`STORE_IO`, `NOT_FOUND`, `DUPLICATE`, `BACKEND_UNAVAILABLE`,
`EMBEDDING_FAILED`, `CHAT_FAILED`, `PROPOSAL_NOT_FOUND`,
`PROPOSAL_NOT_EXECUTED`, `SNAPSHOT_NOT_FOUND`, `IMPORT_INVALID`,
`EXPORT_TOO_LARGE`, `UNKNOWN`. Network/timeout failures are client-side
`NETWORK` / `TIMEOUT` codes.

## UI conventions

- Use only `--dsw-alias-*`, `--dsw-radius-*`, and `--dsw-elevation-*` theme
  tokens. Literal colors are reserved for artwork.
- Do not import any Harness Client package. React comes from the browser module
  table; controls and layout are plugin-owned.
- Do not use `dangerouslySetInnerHTML`. Memory text is rendered as text with
  `white-space: pre-wrap`.
- Labels for every input, `role="status"` / `role="alert"` for notices,
  visible focus, and disabled states while a request is in flight.
- The page never reads or writes the filesystem; every operation goes through
  the host API.
