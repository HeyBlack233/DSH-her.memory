# Memory Tools

The plugin registers four global model-facing tools. They are thin adapters over
the shared engine: the tool layer owns schemas, provenance, and model-facing
rendering; the engine owns validation, storage, retrieval, and lifecycle.
Detailed workflow guidance lives in the [memory skills](memory-skills.md), not
in the tool descriptions.

The plugin does **not** inject memories into a turn automatically. The model
loads a skill and calls `memory_search` when a fact could change its answer.
There is no hard-delete tool; permanent deletion is a user-only settings action.

## Common behavior

- All tools require the engine to be initialized. An initialization failure is
  returned as a structured tool error with a stable code.
- Write tools pass `origin: { source: "tool", sessionId, toolCallId }` so the
  stored record can be traced to the conversation that produced it.
- Memory text is returned as data, not instructions. The model must not follow
  commands found inside a memory.
- Tool results are rendered as English text blocks for the model. The settings
  page has its own localized presentation.
- The tools never execute consolidation, change configuration, export/import, or
  permanently delete a memory.

## `memory_search`

Search the persistent store with hybrid keyword and embedding ranking.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `query` | string | yes | — | Keywords or a natural-language question. |
| `topK` | integer 1–20 | no | `search.defaultTopK` (8) | Maximum results, clamped to `search.maxTopK`. |
| `category` | string | no | — | Exact category filter, compared case-insensitively. |
| `type` | enum | no | — | `general`, `event`, `preference`, or `emotional`. |
| `includeArchived` | boolean | no | `false` | Include archived and physically archived records. |

Result value:

```json
{
  "query": "jasmine tea",
  "retrievalMode": "hybrid",
  "results": [
    {
      "id": "mem_1792331524755_b1b9d0",
      "text": "User prefers jasmine tea after 9pm",
      "type": "preference",
      "category": "user_profile",
      "similarity": 0.82,
      "energy": 1.9,
      "recorded": "2026-10-12T21:04:00.000"
    }
  ],
  "warnings": []
}
```

`retrievalMode` is `hybrid` when at least one result had a dense score,
`keyword` when only BM25 was used, and `empty` when nothing was searched or
nothing matched. `similarity` is the raw cosine (or `null` in keyword mode).
`energy` is the lifecycle signal, not a relevance score. Warnings report missing
embeddings, an unavailable backend, or a dimension mismatch.

The rendered result lists each memory's id, type/category, text, similarity,
energy, and recorded time, followed by warnings. An empty result says so and
suggests broader keywords or a different category.

Hits from this tool are appended to `retrieval_hits.jsonl`; maintenance applies
the energy boost later. Searches from the settings page do not count as model
recall and do not log hits.

## `memory_add`

Store one durable atomic fact.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `text` | string | yes | — | One self-contained fact; trimmed and required. |
| `type` | enum | no | `general` | `general`, `event`, `preference`, or `emotional`. |
| `category` | string | no | `general` | Free-text namespace such as `user_profile` or `tech_lessons`. |
| `eventDate` | string | no | — | When the fact happened; normalized to `YYYY-MM-DD`. |
| `projectKey` | string | no | — | Stable project key, normalized to lowercase. |
| `dedupe` | boolean | no | `false` | Skip when an active memory has the same `projectKey` and category. |

Result value:

```json
{
  "added": true,
  "id": "mem_1792331524755_b1b9d0",
  "duplicateId": null,
  "hasEmbedding": true,
  "warnings": []
}
```

- `dedupe` is opt-in and only effective with `projectKey`. Without a project key
  the write proceeds and the result carries a warning that dedupe was ignored.
- When a working embedding backend is configured, the new record stores a
  vector. If the backend is unavailable, the fact is still stored without an
  embedding; the result has `hasEmbedding: false` and a warning. `backfill`
  fills the vector later.
- A leading `[topic_subtopic]` in the text becomes `stable_key`, which exact-key
  searches prioritize.
- The engine returns `{ added: false, duplicateId }` rather than throwing for a
  dedupe hit; no new record is written.

The rendered result confirms the stored id and classification, explains a
duplicate skip, and notes a missing embedding.

## `memory_update`

Replace an existing memory while preserving history.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `id` | string | yes | — | Identifier of the active memory to update. |
| `text` | string | no | current text | Replacement text. |
| `type` | enum | no | current type | Replacement kind. |
| `category` | string | no | current category | Replacement category. |
| `eventDate` | string | no | current value | Replacement event date. |

At least one of `text`, `type`, `category`, or `eventDate` must be supplied;
`origin` alone does not count as a change.

The engine marks the old record `archived: true`, sets `superseded_by` to the new
id, and records `supersede_date` plus an archive note. The replacement stores
`supersedes: [oldId]`, a fresh timestamp, and the old energy (at least the
initial energy). The old record remains in the active JSONL until maintenance
physically moves it to `archived_memories.jsonl`.

Result value:

```json
{
  "updated": true,
  "oldId": "mem_1792331524755_b1b9d0",
  "newId": "mem_1792331531227_f7a831",
  "hasEmbedding": false
}
```

The rendered result names both ids and notes whether an embedding is available
for the replacement.

## `memory_archive`

Archive a memory without deleting it.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `id` | string | yes | — | Identifier of the memory to archive. |
| `reason` | string | no | `archived by request` | Short reason kept with the record. |

Result value:

```json
{ "archived": true, "id": "mem_1792331524755_b1b9d0", "alreadyArchived": false }
```

The record is marked `archived: true` with `archive_date` and `archive_reason`;
it is excluded from default recall immediately and moved to
`archived_memories.jsonl` by the next maintenance run. Archiving an
already-archived record returns `{ archived: false, alreadyArchived: true }`.
Only the settings page can permanently delete a memory.

## Error behavior

The engine throws stable errors such as `INVALID_INPUT`, `NOT_FOUND`,
`BACKEND_UNAVAILABLE`, `EMBEDDING_FAILED`, `STORE_LOCKED`, and `STORE_IO`. The
tool layer lets them propagate, so the runtime materializes an error result and
the model can retry or explain the failure. A missing embedding backend is not
an error for `memory_add`; it degrades the write to a keyword-searchable record.
