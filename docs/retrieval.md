# Retrieval

This document specifies how memory search ranks records: the tokenizer, BM25,
dense cosine weighting, reciprocal rank fusion, stable-key priority, filters,
fallbacks, the result shape, the hit log feedback loop, and performance
characteristics. `lib/retrieval.js` implements the kernel described here.
Storage and record fields are specified in [`data-model.md`](data-model.md);
tuning values and their ranges are specified in
[`configuration.md`](configuration.md).

## Why hybrid retrieval

Neither signal is sufficient for companion memory:

- Pure vector search finds text that is *literally similar*. It misses the
  entry whose wording differs from the query, and it can rank an emotionally
  similar entry above the technically correct one — "semantic ≠ causal".
- Pure BM25 finds exact symbols — file names, ports, error codes, IDs — but
  returns nothing useful for paraphrase or for a query that shares no tokens
  with the stored fact.

The plugin runs both rankings over the same candidate set and fuses their
**ranks** with Reciprocal Rank Fusion (RRF). RRF needs no calibration between
BM25 scores and cosine similarities, because ranks are comparable even when
scores are not. The cost is one in-memory index build per query, which is
acceptable at the intended scale.

## Pipeline

`searchMemories` in `lib/retrieval.js` runs these steps in order:

1. Discard candidates that are not objects; drop records with `archived: true`
   (or `_archived: true`) unless `includeArchived` is true. Category and type
   filters are applied by the engine before this call.
2. Return an empty envelope when the query is blank, `topK` is zero, or no
   candidate remains.
3. Extract the first bracketed stable key from the query and mark exact matches.
4. Build a BM25 index over all candidates and score the query.
5. Request one query embedding when a backend other than `none` is configured.
6. Compute energy-weighted cosine scores for candidates whose embedding is
   usable.
7. Rank the non-key candidates by weighted dense score and by positive BM25
   score, then fuse those two rankings with RRF.
8. Emit stable-key hits first, then fused results, and truncate to `topK`.
9. Report `retrievalMode` and any warnings.

The kernel does not log hits, enforce `maxResultChars`, or apply category/type
filters; the engine does those around it. See
[Hit logging and the energy loop](#hit-logging-and-the-energy-loop) and
[`data-model.md`](data-model.md).

## Tokenizer

Documents and queries are lowercased, then tokenized with:

```
[a-z0-9_]+|[\u4e00-\u9fff]
```

Consequences worth knowing:

| Input | Tokens |
|---|---|
| `nightly_job.py exited` | `nightly_job`, `py`, `exited` |
| `port 9880, code 15` | `port`, `9880`, `code`, `15` |
| `23:00` | `23`, `00` |
| `jasmine tea` | `jasmine`, `tea` |
| A four-character CJK phrase | One token per character |

English words, digits, and underscores survive as units, which keeps entities
such as `SoVITS` or `9880` intact. Punctuation is a separator, so `nightly_job.py`
also matches a query for `nightly_job`. Chinese is indexed per character, which
needs no external segmenter and works at this corpus size.

The reference implementation does not lowercase; this plugin does, so `User` and
`user` match. No stop-word list is applied: terms that occur in every document
receive an IDF near zero and contribute almost nothing.

## BM25

Parameters: `k1 = 1.5`, `b = 0.75`. For a query term `t` in document `d`, with
document frequency `n`, corpus size `N`, document length `dl`, and average
document length `avgdl`:

```
idf(t)   = ln((N - n + 0.5) / (n + 0.5) + 1)
score(d) = Σ_t idf(t) * f(t,d) * (k1 + 1) / (f(t,d) + k1 * (1 - b + b * dl / avgdl))
```

Only documents with a positive BM25 score enter the sparse ranking; zero-score
documents contribute no RRF term. This prevents the tail of the corpus from
picking up index-order noise and diluting a real match. If no document scores
positively, the sparse ranking is empty and fusion proceeds with the dense
ranking alone.

The index is built over the candidate set on each call. There is no persistent
BM25 index and no stop-word pruning.

## Dense scoring

Each candidate with a usable embedding is compared to the query vector by
cosine similarity:

```
cosine(a, b) = (a · b) / (||a|| * ||b||)
```

A zero-norm or mismatched-length vector scores `0`. The cosine is then weighted
by the record's energy so stale memories cannot dominate purely by embedding
similarity:

```
w(energy) = 0.5 + 0.5 * min(energy, energyMax) / energyMax
denseScore = cosine * w
```

With the default `energyMax = 5.0`, the weight lies in `[0.5, 1.0]`: a fresh
2.0-energy record gets `0.7`, a fully charged 5.0 record gets `1.0`, and a
nearly archived record approaches `0.5`. The dense ranking sorts by
`denseScore`; the reported `similarity` is the raw cosine.

`search.minSimilarity` is compared against the **weighted dense score**, not the
raw cosine. Candidates below the threshold are excluded from the dense ranking
but remain eligible for BM25. Configuration validation restricts the value to
`0..1`.

## Reciprocal Rank Fusion

With `k = search.rrfK` (default 60) and 1-based ranks:

```
RRF(d) = 1 / (k + rank_dense(d)) + 1 / (k + rank_bm25(d))
```

A document missing from a ranking contributes nothing for that term. The first
rank therefore contributes `1/61 ≈ 0.01639`; a document ranked highly in both
lists accumulates two large terms and outranks a one-signal fluke. Ties are
broken by ascending candidate index — the position in the filtered corpus — so
results are deterministic.

## Stable-key priority

A query may carry an explicit key. The first bracket token matching
`\[[^\[\]]{2,40}\]` is extracted and compared against `stable_key` values.
A record also matches when its `text` starts with that exact bracket token.

Rules:

- Archived filtering runs first: a key hit is not returned unless
  `includeArchived` is true. Category and type filters were already applied by
  the engine.
- All key hits are emitted first, in candidate order, and count toward `topK`.
  If there are more key hits than `topK`, the first `topK` in candidate order
  are returned and no fused results appear.
- Key hits are removed from the fused candidate set so a record never appears
  twice.
- `rrf` is `null` for a key hit. `bm25` is its BM25 score, and `similarity` is
  the raw cosine when a query embedding was computed and the record's embedding
  is usable; otherwise `similarity` is `null`.
- A query without a bracket token, or one whose token matches nothing, proceeds
  as an ordinary hybrid search.

This implements "when the key is sufficient, do not search first": a deliberate
lookup is exact and cheap, while ordinary language queries still get hybrid
recall.

## Filters and `includeArchived`

| Parameter | Effect |
|---|---|
| `category` | Engine-side filter: exact string match on the stored `category`. |
| `type` | Engine-side filter: one of `general`, `event`, `preference`, `emotional`. |
| `includeArchived` | Kernel-side filter. Default `false` excludes records with `archived: true` or `_archived: true`; `true` also returns records read from the archived file. |
| `topK` | Clamped by the caller to `[1, search.maxTopK]`; defaults to `search.defaultTopK`. A zero or negative value returns an empty envelope. |

Filters apply to the candidate set before ranking and before stable-key
matching, so `topK` counts only eligible records.

## `minSimilarity` and the BM25 fallback

When embeddings are unavailable, retrieval degrades to keyword-only:

| Condition | Behavior | Warning |
|---|---|---|
| `backend.kind` is `none` | No embedding request is made; keyword ranking. | None. |
| Backend configured but unreachable or timing out | Keyword ranking; the backend error message is included. | `Embedding backend unavailable; using keyword retrieval (...)` |
| Backend returns an invalid vector | Keyword ranking. | `Embedding backend returned an invalid vector; using keyword retrieval` |
| Dense scores exist but all fall below `minSimilarity` | Dense ranking is empty; keyword ranking still applies. | None beyond embedding warnings. |
| BM25 has no positive scores and dense succeeds | Dense-only ranking. | None. |
| Nothing ranks | Empty result set with `retrievalMode: "empty"`. | None; this is not an error. |

With keyword-only retrieval, RRF still applies to a single list, so each
returned record's `rrf` is `1 / (k + rank)` and the order equals the BM25 order.
The hit log and energy loop are unaffected. A degraded search is still a
successful search: warnings are returned, not thrown.

## Missing and mismatched embeddings

| Situation | Handling |
|---|---|
| Record has no `embedding` | Excluded from the dense ranking, still eligible for BM25. Included in the aggregate warning. |
| `embedding` is not a non-empty array of finite numbers | Treated as missing. |
| Record vector length differs from the query vector | Excluded from the dense ranking; BM25 unaffected. Included in the aggregate warning. |
| Query embedding unavailable | No dense ranking at all; every result has `similarity: null`. |
| A write had no embedding backend | The record is stored without a vector and carries the write-time warning; `backfill` fills it later. |

When a query embedding exists and at least one candidate is skipped, the kernel
adds one warning: `Skipped dense ranking for N memories with missing or
incompatible embeddings`. There is no per-record or per-dimension warning, and
no dimension is persisted in the engine state.

Switching embedding backend, model, or quantization can change vectors; run
`backfill --all` after a switch to avoid a corpus where some records rank by a
different vector space.

## Result shape

`engine.search` returns the kernel envelope:

```json
{
  "query": "jasmine tea",
  "retrievalMode": "hybrid",
  "results": [
    {
      "id": "mem_1791810240000_8f3a1c",
      "text": "User prefers jasmine tea after 9pm.",
      "type": "preference",
      "category": "user_profile",
      "timestamp": "2026-10-12T21:04:00.000",
      "event_date": "2026-10-12",
      "project_key": "user",
      "stable_key": "[tea_pref]",
      "archived": false,
      "energy": 2.0,
      "last_hit": "2026-10-12T21:04:00.000",
      "similarity": 0.81,
      "bm25": 2.968,
      "rrf": 0.032787,
      "retrievalMode": "hybrid"
    }
  ],
  "warnings": []
}
```

| Field | Type | Notes |
|---|---|---|
| `query` | string | The query as received. |
| `retrievalMode` | string | `hybrid` when at least one result had a dense score, `keyword` when only BM25 was used, `empty` when nothing was searched or nothing matched. |
| `results` | object[] | Stable-key hits first, then fused results, truncated to `topK`. |
| `warnings` | string[] | Human-readable strings; the tool layer forwards them as strings. |

Result items:

| Field | Type | Notes |
|---|---|---|
| `id`, `text`, `type`, `category` | string | Defaults: empty ID/text, `general` type/category. |
| `timestamp`, `event_date`, `project_key`, `stable_key` | string \| null | Copied from the record; `null` when absent. |
| `archived` | boolean | True for `archived` or `_archived`. |
| `energy` | number | Record energy, defaulting to `2.0`. |
| `last_hit` | string \| null | Stored value. |
| `similarity` | number \| null | Raw cosine rounded to 3 decimals; `null` when no dense score was computed. |
| `bm25` | number | BM25 score rounded to 4 decimals. |
| `rrf` | number \| null | Fused score rounded to 6 decimals; `null` for stable-key hits. |
| `retrievalMode` | string | Per-item `hybrid` when `similarity` is set, else `keyword`. |

The `memory_search` tool projects each item onto its model-facing schema:
`{ id, text, type, category, similarity, energy, recorded }`, where
`recorded` is the record's `recorded` field when the engine supplies one and
`timestamp` otherwise, and `similarity` falls back to `0` when no cosine exists.
The tool result also carries `query`, `retrievalMode`, and `warnings`; its
rendering names keyword fallback explicitly. See
[`memory-tools.md`](memory-tools.md).

`search.maxResultChars` is enforced by the engine/tool around the kernel: it
caps the total `text` characters returned across results. The kernel itself
does not truncate.

## Hit logging and the energy loop

After the final result list is fixed, the engine appends one line per returned
record to `retrieval_hits.jsonl`:

```json
{"id":"mem_1791810240000_8f3a1c","ts":"2026-10-18T21:40:02.145"}
```

- Only returned records are logged; candidates that were scored but not
  returned are not.
- Stable-key hits are logged too, because they are recall.
- Appends go through a per-store promise queue. A failure yields a warning and
  does not fail the search or change the results.
- No query text is stored, so the log cannot reveal what the user asked.
- Maintenance drains the log as a set of IDs and applies
  `maintenance.energyHitBoost` and `last_hit = now` once per ID, caps energy at
  `maintenance.energyMax`, then truncates the log after the memory write
  succeeds. Details are in [`data-model.md`](data-model.md).

The feedback loop is intentionally slow: a hit boosts the energy weight used by
future dense ranking, and decay pulls unused memories down over days. BM25 does
not use energy, so keyword recall stays stable regardless of lifecycle state.

## Performance and scale

| Aspect | Behavior |
|---|---|
| Intended corpus size | 10³–10⁴ records. |
| Corpus load | Full JSONL read on first access; parsed entries are cached per file by mtime and size, so unchanged files are not re-parsed. |
| Index lifetime | BM25 index built per search over the filtered candidates, then discarded. |
| Dense cost | One cosine per candidate vector with a usable embedding; O(N · d) with `d` typically 1024. |
| BM25 cost | One scoring pass per candidate; O(N · query terms). |
| Backend latency | When embeddings are enabled, one HTTP embedding request dominates search latency; keyword-only search avoids it. |
| Memory footprint | The corpus is held in memory while cached; inline embeddings dominate size (roughly 9–20 KB per 1024-dimension record depending on float formatting). |
| Persistence visibility | The cache key includes mtime and size, so a write by another DSH process invalidates it on the next read. |

There is no vector database, no ANN index, and no persistent BM25 index. At 10³
records this is a few milliseconds of scoring plus backend latency; at 10⁴
records the cosine pass and the memory footprint become noticeable. Beyond
roughly 10⁵ records, or where sub-100 ms latency is required, a real vector
store with a keyword sidecar is the right tool — it is out of scope here.

## Worked example

Corpus (five active records, embeddings enabled, `energyMax = 5.0`). IDs are
shortened to labels for readability:

| Label | Text | Type | Energy |
|---|---|---|---|
| A | `nightly_job.py exited with code 15 at 23:00; the state file was stale.` | event | 2.0 |
| B | `User felt drained by late-night on-call shifts.` | emotional | 2.0 |
| C | `User prefers jasmine tea in the evening.` | preference | 2.0 |
| D | `Deploys run from the release branch.` | general | 3.0 |
| E | `The cat is named Mochi.` | general | 1.0 |

Query: `nightly_job.py failed`, `topK = 3`, no filters, default
`minSimilarity = 0`.

**Tokenization.** Query tokens: `nightly_job`, `py`, `failed`. Document lengths
are 14, 9, 7, 6, and 5, so `avgdl = 8.2` and `N = 5`.

**BM25.** `nightly_job` and `py` occur only in A, giving each
`idf = ln(4) ≈ 1.3863`; `failed` occurs nowhere and contributes zero. Only A has
a positive score:

| Label | BM25 | Sparse rank |
|---|---|---|
| A | 2.1032 | 1 |
| others | 0 | — |

**Dense.** The illustrative cosines and the energy weights produce:

| Label | Cosine | Weight | Dense score | Dense rank |
|---|---|---|---|---|
| A | 0.55 | 0.70 | 0.385 | 3 |
| B | 0.68 | 0.70 | 0.476 | 1 |
| C | 0.61 | 0.70 | 0.427 | 2 |
| D | 0.22 | 0.80 | 0.176 | 4 |
| E | 0.09 | 0.60 | 0.054 | 5 |

Pure vector retrieval would answer B — the emotionally similar but wrong record.
Fusion corrects that.

**RRF** with `k = 60`:

| Label | Dense term | BM25 term | RRF | Final rank |
|---|---|---|---|---|
| A | 1/63 = 0.015873 | 1/61 = 0.016393 | 0.032266 | 1 |
| B | 1/61 = 0.016393 | — | 0.016393 | 2 |
| C | 1/62 = 0.016129 | — | 0.016129 | 3 |
| D | 1/64 = 0.015625 | — | 0.015625 | — |
| E | 1/65 = 0.015385 | — | 0.015385 | — |

A wins because it is the only record ranked by both lists, even though the dense
path placed it third. B and C keep their dense order.

**Fallbacks in the same corpus.** Query `jasmine tea` tokenizes to `jasmine`,
`tea`; C has both (`idf ≈ 1.3863`, BM25 ≈ 2.968) and is the only sparse hit. With
the backend disabled, the sparse list alone returns C first with
`rrf = 1/61 = 0.016393`, `similarity: null`, and `retrievalMode: "keyword"`.
Query `[tea_pref]`, with a record whose `stable_key` is `[tea_pref]`, returns
that record first with `rrf: null` and its raw cosine in `similarity` when an
embedding was computed.

## Current limitations

- No reranker or LLM judge in the retrieval path; ranking is BM25, cosine, and
  RRF only.
- No query expansion, synonym list, or stemming.
- No negative feedback: a result the user ignores still counts as a hit and
  gains energy.
- BM25 ignores energy, so a stale record can still win a keyword query.
- Stable-key extraction matches only one bracket token per query.
- The BM25 index is rebuilt per search; only parsed file contents are cached.
- Dense recall depends on the configured embedding backend; without one,
  paraphrase queries degrade to keyword matching.
