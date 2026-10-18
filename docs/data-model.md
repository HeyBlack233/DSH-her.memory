# Data Model

This document specifies the bytes the plugin stores: the directory layout, the
JSONL record, concurrency and durability rules, identifiers and timestamps, the
energy and archive lifecycle, the version stamp, the hit log, import/export, and
file privacy. Ranking is specified in [`retrieval.md`](retrieval.md); the config
and state files are specified in
[`configuration.md`](configuration.md); proposal documents are specified in
[`consolidation.md`](consolidation.md).

`lib/store.js` is the source of truth for the mechanics below. Where
[`implementation-plan.md`](implementation-plan.md) leaves a storage detail open,
this document records the implemented behavior.

## File layout

```
$DSH_HOME/her-memory/                    # plugin home
├── config.json                          # plugin configuration (0600)
├── state.json                           # timestamps and last error (0600)
└── memories/                            # default memoryDir
    ├── semantic_memories.jsonl          # active records, plus archived-marked records
    ├── semantic_memories.jsonl.lock     # cross-process write lock
    ├── archived_memories.jsonl          # physically archived records
    ├── retrieval_hits.jsonl             # append-only hit log
    ├── semantic_version.json            # content stamp
    ├── _snapshots/                      # flat copies taken before destructive operations
    └── _proposals/                      # consolidation proposal documents
```

`$DSH_HOME` defaults to `~/.dsh`. `config.json` may set `memoryDir` to another
directory, including an existing `her.memory` checkout. A relative `memoryDir`
resolves against the plugin home; `null` or an empty value means
`<home>/memories`. When it is set, the memory files, lock, stamp, hit log,
snapshots, and proposals all live in that directory. `config.json` and
`state.json` stay in the plugin home, because they describe the plugin rather
than the corpus.

| File | Writer | Purpose |
|---|---|---|
| `semantic_memories.jsonl` | `JsonlStore.writeActive` | Active corpus; holds records with `archived: false` and records marked `archived: true` that await physical archiving. |
| `semantic_memories.jsonl.lock` | `JsonlStore.withLock` | Exclusive-create lock guarding every write transaction. |
| `archived_memories.jsonl` | `JsonlStore.writeArchive` | Physically archived records. |
| `retrieval_hits.jsonl` | `JsonlStore.logHit` | One `{id, ts}` line per returned result, drained by maintenance. |
| `semantic_version.json` | `lib/version-stamp.js` | Content hash and counts, compatible with `her.memory`. |
| `_snapshots/` | `JsonlStore.snapshot` | Flat copies of both JSONL files plus a `backup_<stamp>.json` manifest. |
| `_proposals/` | `lib/consolidation.js` | Proposal JSON documents and their review state. |

Both JSONL files are UTF-8, one JSON object per line, no pretty printing, no BOM,
and every line ends with `\n`. The plugin never writes inside its own package
directory.

## The JSONL record

A record is one atomic fact. Every record the plugin writes has the core fields
below; optional fields appear only when they carry information.

### Core fields

| Field | Type | Required | Rules |
|---|---|---|---|
| `id` | string | Yes | `mem_<epoch-ms>_<6 lowercase hex>`, for example `mem_1791810240000_8f3a1c`. Opaque; never reused. |
| `text` | string | Yes | One atomic fact, written to be understood out of context. |
| `type` | string enum | Yes | `general`, `event`, `preference`, or `emotional`. Defaults to `general`. |
| `category` | string | Yes | Free-text namespace such as `user_profile` or `tech_lessons`; defaults to `general`. |
| `timestamp` | string | Yes | When the record was written, local time without offset and with milliseconds: `YYYY-MM-DDTHH:mm:ss.SSS`. |
| `embedding` | number[] | No | Dense vector from the configured backend. Absent when no backend was available at write time; `backfill` fills it. |
| `archived` | boolean | Yes | `true` excludes the record from default retrieval. Set by archive, supersede, and consolidation — never by hand. |
| `energy` | number | Yes | Freshness signal. Fresh records start at `maintenance.energyInitial` (2.0), decay over time, and rise on hits. |
| `last_hit` | string \| null | Yes | Last time retrieval returned the record, in the `timestamp` format. Set to the creation time on insert so the archive clock starts at creation. |

### Optional fields

| Field | Type | Set by | Meaning |
|---|---|---|---|
| `event_date` | string | Add, update, import | When the fact itself happened, normalized to `YYYY-MM-DD`. Distinct from `timestamp`. |
| `project_key` | string | Add, update, import | Dedupe and supersede grouping key. Records without it are exempt from key-controlled dedupe. |
| `stable_key` | string | Add, update, import | Exact-lookup key in the form `[lower_snake_key]`, 2–40 characters inside the brackets. Matched directly by retrieval. |
| `superseded_by` | string | Supersede | ID of the replacement record. |
| `supersedes` | string[] | Supersede | IDs of the records this one replaces. |
| `supersede_date` | string | Supersede | ISO timestamp of the replacement, in the `timestamp` format. |
| `merged_from` | string[] | Consolidation execute | IDs of the records folded into this one. |
| `merged_into` | string | Consolidation execute | ID of the record this one was folded into; written on the archived members. |
| `merge_date` | string | Consolidation execute | ISO timestamp of the merge, in the `timestamp` format. |
| `merge_proposal` | string | Consolidation execute | Proposal ID that authorized the merge. |
| `origin` | object | Add, update, archive, import | Provenance: `{ source, sessionId?, toolCallId? }`. `source` is `tool`, `settings`, `consolidation`, `import`, or `maintenance`. |
| `archive_date` | string | Archive, maintenance | ISO timestamp of archiving, in the `timestamp` format. |
| `archive_reason` | string | Archive, maintenance | Short machine-readable reason such as `manual`, `superseded`, `unhit`, `low_energy`, or `merged`. |

### Examples

An active preference with a stable key and an embedding elided for readability:

```json
{"id":"mem_1791810240000_8f3a1c","text":"User prefers jasmine tea after 9pm.","type":"preference","category":"user_profile","timestamp":"2026-10-12T21:04:00.000","event_date":"2026-10-12","embedding":[0.0123,-0.0456],"archived":false,"energy":2.0,"last_hit":"2026-10-12T21:04:00.000","stable_key":"[tea_pref]","project_key":"user","origin":{"source":"tool","sessionId":"s-7f2a","toolCallId":"call-01"}}
```

A superseded record, still in the active file and awaiting compaction:

```json
{"id":"mem_1768795200000_4b7d02","text":"User lived in Riverton from 2018 to 2026.","type":"event","category":"shared_history","timestamp":"2026-02-03T10:15:00.000","event_date":"2018-01-01","archived":true,"energy":1.4,"last_hit":"2026-02-03T10:15:00.000","superseded_by":"mem_1791810245000_c92e51","supersede_date":"2026-10-18T11:05:00.000","archive_date":"2026-10-18T11:05:00.000","archive_reason":"superseded","origin":{"source":"tool","sessionId":"s-7f2a","toolCallId":"call-07"}}
```

A merged record produced by an approved proposal:

```json
{"id":"mem_1791811200000_d1f077","text":"User drinks jasmine tea in the evening and avoids coffee after 21:00.","type":"preference","category":"user_profile","timestamp":"2026-10-18T11:20:00.000","archived":false,"energy":3.2,"last_hit":"2026-10-18T11:20:00.000","merged_from":["mem_1791810240000_8f3a1c","mem_1791534600000_a55b10"],"merge_date":"2026-10-18T11:20:00.000","merge_proposal":"p-20261018-1","origin":{"source":"consolidation"}}
```

The merged record is active. Its source records are archived in place with
`merged_into` set and are moved to the archived file by the next maintenance
run.

## Atomicity and concurrency

### Write transactions

Every mutation runs inside `JsonlStore.transaction`, which is `withLock` plus a
transaction object exposing `loadActive`, `loadArchive`, `writeActive`, and
`writeArchive`:

1. Acquire the in-process mutex.
2. Acquire the cross-process lock.
3. Read the files the operation touches.
4. Apply the change in memory.
5. Rewrite the affected file atomically.
6. Release the lock in a `finally` block.

There is no raw append. `appendActive` is a read-modify-write: it loads the
active file, pushes the new record, and atomically replaces the file. `add`,
`update`, `archive`, compaction, and `import` all use the same atomic rewrite, so
readers never observe a partially written file.

### Lock

- Path: `<memoryDir>/semantic_memories.jsonl.lock` (derived from the active
  file path plus `.lock`).
- Creation: `open(path, "wx", 0o600)` — exclusive create. The file contains
  `{"pid":<number>,"token":"<pid>_<epoch-ms>_<12 hex>","startedAt":"<ISO>"}`.
- Acquisition order: the in-process mutex first, so two operations in one
  process never contend on the file. Then the file lock is polled with a
  randomized 50–500 ms backoff for up to 5 seconds; expiry throws
  `STORE_LOCKED`.
- Staleness: a lock is stale when its age exceeds 120 seconds or when its `pid`
  is a positive integer that no longer exists (`process.kill(pid, 0)` fails with
  `ESRCH`). A stale lock is unlinked and acquisition retries. There is no
  heartbeat and no rename-based steal.
- Release: the holder re-reads the lock and unlinks it only when its `token`
  still matches. A lock that was replaced or stolen is left alone.
- IO failures while creating or inspecting the lock surface as `STORE_IO`.

`her.memory`'s Python tools use the same lock file name but a different protocol
(and on Unix they degrade to unlocked operation), so the two implementations do
not exclude each other. Do not run both against one directory at the same time.

### Atomic replacement

`atomicWrite` (in `lib/util.js`) writes `.<basename>.<pid>.<8 hex>.tmp` in the
target directory, writes the content, fsyncs the handle, closes it, and renames
over the target. The mode is applied when the temporary file is created
(`0600`). On failure the temporary file is unlinked and the error surfaces as
`STORE_IO` without touching the original. A crash leaves only a temporary file,
which is not part of the corpus; it is never read as a memory file.

Readers take no lock. They rely on rename atomicity: a reader sees either the old
file or the new one, never a half-written rewrite.

### Corrupt lines

Loading is tolerant so one damaged byte never loses the rest of the corpus:

| Situation | Behavior |
|---|---|
| Blank line | Skipped. |
| Not valid JSON, or JSON that is not an object | Skipped from the loaded entries and appended to `<file>.corrupt.bak` as a JSON line `{lineno, error, fragment}`, where `fragment` is the first 100 characters. The corpus file itself is left untouched. |
| Invalid UTF-8 | Decoded with replacement characters; if the result is not valid JSON, treated as corrupt. |
| Duplicate `id` | Not resolved. Records are returned in file order; the ID generator makes accidental duplicates unlikely, and hand-edited duplicates remain separate records. |
| Missing `id` | Read as an empty identifier. The record is visible in search results and listings but cannot be addressed by update, archive, or delete. |

Corruption counts are reported by `stats().corruptLines` for the Overview tab.
Corrupt lines are not re-emitted on rewrite: the original bytes stay in the
corpus file until a rewrite replaces it, while the backup preserves the
diagnostic record.

## Identifiers and timestamps

- **IDs** are `mem_<epoch-ms>_<6 lowercase hex>`, generated by
  `newMemoryId()` from `Date.now()` and 3 random bytes. The embedded epoch is
  incidental; consumers must treat the ID as opaque. IDs are never reused.
- **`timestamp`**, **`last_hit`**, **`supersede_date`**, **`merge_date`**, and
  **`archive_date`** are local wall-clock time formatted
  `YYYY-MM-DDTHH:mm:ss.SSS`, with no offset, no `Z`, and milliseconds. This is
  the shape `her.memory` writes (`datetime.now().isoformat()`), and it keeps
  exported JSONL portable. Strings sort chronologically within one timezone; a
  daylight-saving fallback can repeat an hour, in which case file order breaks
  the tie.
- **`event_date`** accepts an ISO 8601 date or date-time and is normalized to
  `YYYY-MM-DD` before storage. Consolidation and the UI compare it by that date.
- **The stamp's `built_at`** uses `YYYY-MM-DD HH:MM:SS` for parity with
  `her.memory`; snapshot names use `YYYYMMDD_HHMMSS_<4 hex>`.

## Energy, hits, and the archive lifecycle

- A new record starts at `energy = maintenance.energyInitial` (2.0) with
  `last_hit` equal to its creation timestamp.
- A retrieved record gains `maintenance.energyHitBoost` (0.2), capped at
  `maintenance.energyMax` (5.0), and its `last_hit` becomes the settlement time.
- Maintenance decays every active record by `energyDecay` (0.97) once per run,
  with a floor of `0.1`. Automatic runs are due every `maintenance.intervalHours`
  (24 by default); a manual run applies one decay step regardless of how many
  days have elapsed since the previous run.
- Maintenance archives an active record when its `last_hit` is older than
  `maintenance.archiveDays`. Consolidation may additionally propose low-energy
  records for archiving using `consolidation.energyArchiveThreshold`; that path
  is specified in [`consolidation.md`](consolidation.md).
- The archive lifecycle has three visible states:

| State | Where the record lives | Flags |
|---|---|---|
| Active | `semantic_memories.jsonl` | `archived: false` |
| Archived, pending compaction | `semantic_memories.jsonl` | `archived: true` plus `archive_date` and `archive_reason` |
| Physically archived | `archived_memories.jsonl` | `archived: true` |

- `engine.delete` with `confirm: true` permanently removes a record from
  whichever file holds it. Permanent deletion is reachable only from the
  settings page, never from a model tool. Snapshots may still contain the
  record; see [Privacy and file permissions](#privacy-and-file-permissions).
- **Pending compaction** is the number of archived-marked records still in the
  active file. It is computed by `store.stats()`, not stored in `state.json`,
  and shown on the Overview tab. Maintenance compacts those records; nothing
  else moves records between files.

## Version stamp

`semantic_version.json` answers "which version of the corpus did I read?". It is
compatible with `her.memory`'s `stamp_semantic.py`: same field order, same
delimiter, same both-file scan, same snake_case payload.

Algorithm:

1. Scan `semantic_memories.jsonl` in file order, then `archived_memories.jsonl`
   if it exists.
2. For each parseable object, build the stable key
   `type \x1f category \x1f date \x1f text`, where `text` is `text` or `content`,
   `date` is `event_date` or `date` (empty when neither exists), and missing
   `type`/`category` contribute an empty string.
3. Feed each key as UTF-8 to SHA-256, followed by a single `\n`.
4. Count records read and records archived (anything in the archived file, or
   with `archived: true` / `_archived: true`).

The payload is written atomically:

```json
{
  "schema_version": 1,
  "content_sha256": "4d1e...",
  "version_short": "4d1e9a02c7b1",
  "entries_total": 1284,
  "entries_archived": 311,
  "entries_active": 973,
  "built_at": "2026-10-18 21:42:10",
  "note": "Memory corpus content stamp; recompute after batch changes."
}
```

`stamp()` recomputes and writes this file after every content-changing write.
Embeddings, energy, `last_hit`, and hit lines are deliberately excluded, so
maintenance that only decays energy does not change the version. If a process
crashes between a corpus write and the stamp write, the stamp is stale; the
settings page can recompute it, and the next content-changing write fixes it.

## Hit log

`retrieval_hits.jsonl` stores one line per returned result:

```json
{"id":"mem_1791810240000_8f3a1c","ts":"2026-10-18T21:40:02.145"}
```

- `logHit` appends through a promise queue, so concurrent searches in one process
  do not interleave partial lines. Failure is a warning, never a search failure.
- Only records actually returned to the caller are logged, not every candidate.
- No query text is stored. The log cannot be used to reconstruct what the user
  asked, only which memories were surfaced.
- `drainHits({ keep })` returns one ID per line in file order, deduplicated.
  `keep: true` leaves the log in place so the caller can truncate it only after
  the corpus write succeeds; `keep: false` truncates immediately.
- `clearHits` truncates with `truncate(file, 0)` rather than unlinking, so a
  process holding the file open cannot resurrect stale hits.
- Corrupt hit lines are ignored and disappear on the next truncation.

## Import and export

### Export

`engine.exportData()` returns JSONL text, not a wrapper object:

- the active file's records in file order, then the archived file's records;
- UTF-8 without BOM, one compact JSON object per line, trailing newline;
- embeddings included as stored;
- unknown fields preserved verbatim.

The result is directly usable as a `her.memory` `semantic_memories.jsonl`
(archived entries are present with `archived: true`, and `her.memory`'s
maintenance will compact them). Export is intended to fail with
`EXPORT_TOO_LARGE` above 10 MiB of output; archive or prune before exporting.

### Import

`engine.importData({ jsonl, backfill })` accepts the same JSONL shape:

- The import is all-or-nothing: any line that is not a JSON object or has no
  usable text fails the whole import with `IMPORT_INVALID` before anything is
  written.
- A record whose `id` already exists is skipped and counted; it is not
  overwritten.
- A missing `id` is generated; a missing `timestamp` becomes now; a missing
  `type` becomes `general`; missing `energy` and `last_hit` become the defaults.
- Unknown fields are preserved.
- Records marked `archived: true` are written to the active file and become
  pending compaction.
- `backfill: true` embeds imported records that have no embedding after the
  write. Embedding failures are warnings and leave the record without a vector.
- The result reports added, skipped, embedded, and warning counts. The stamp is
  recomputed once at the end.

## Privacy and file permissions

- Directories are created by `ensureDirs` with the process umask; files written
  through `atomicWrite` and the lock are created with mode `0600`. On Windows
  these modes are a best effort; the plugin does not rewrite inherited ACLs.
- Everything stays local unless a backend URL points at a remote host. The
  default preset URLs are loopback addresses.
- The hit log contains no queries. `state.json` contains no memory text. Error
  messages and logs reference IDs and counts, not content.
- `config.json` may contain backend API keys in plaintext. The API redacts them;
  the file is protected only by its mode.
- Snapshots are full copies of the JSONL files, so a record deleted through the
  settings page can survive in `_snapshots/`. The plugin does not prune
  snapshots automatically; removing a file is a manual action.
- `memoryDir` may point at a synchronized or shared volume. The plugin cannot
  prevent the sync client or other local users from copying the files.
- There is no encryption at rest. Protecting the memory corpus is the operating
  system's job, and the API is same-origin only.

## Current limitations

- Record history relies on supersede and merge chains plus snapshots; there is
  no per-record revision log.
- The stamp covers content fields only, not embeddings, energy, or `last_hit`.
- There is no automatic snapshot retention policy; snapshots accumulate.
- Rewrites cost proportional to the file size, and inline embeddings dominate
  that size. Every write, including `add`, rewrites the active file.
- Import does not validate embedding dimensions; retrieval warns about
  incompatible vectors and skips them for dense ranking.
- Files are human-editable by design. Hand edits that break JSON become corrupt
  lines backed up to `.corrupt.bak`; hand edits that change `id` break supersede
  and merge chains.
