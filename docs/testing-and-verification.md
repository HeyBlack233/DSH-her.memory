# Testing and Verification

This document describes how the plugin is tested and verified: the automated
test strategy, the per-module coverage matrix, the commands to run, and the live
verification checklist performed against a dedicated profile.

## Strategy

- Tests run under `node:test` using built-in modules only; no third-party test
  framework or mocking library is required.
- Each test works in a temporary directory so no test touches real user data.
- Backend calls are served by a fake HTTP server that stands in for both
  supported backends:
  - Ollama: `/api/embeddings` and `/api/generate`
  - OpenAI-compatible: `/v1/embeddings` and `/v1/chat/completions`
- The fake backend is scripted to reproduce each behavior class: success,
  HTTP error, timeout, and malformed response.
- The suite is deterministic: no test depends on wall-clock timing, network
  availability, or the host DSH installation, so the same run produces the same
  result on any machine.

## Backend behaviors

| Behavior | What it verifies |
|---|---|
| Success | Well-formed embeddings and chat responses are parsed correctly |
| HTTP error | Non-2xx responses surface as typed backend errors |
| Timeout | Unresponsive backends fail fast with a clear timeout error |
| Malformed | Truncated or invalid payloads are rejected without corrupting state |

## Test matrix by module

The matrix is the acceptance contract for the suite: every row must have at
least one test, and a change that removes coverage from a row fails `npm test`.
The rows follow the module boundaries of the codebase, so a failing test points
directly at the affected area.

| Module | Covered behaviors |
|---|---|
| `store` | Append, load, corrupt file, cache, lock timeout, stale lock, dead pid, snapshot, retrieval hits, stats |
| `config` | Defaults, merge, validation, redaction, state persistence |
| `retrieval` | Tokenize, BM25, RRF, hybrid, stable key, filters, energy, missing embeddings, `minSimilarity` |
| `embeddings` | Both wire formats, auth, error handling, test endpoint |
| `lifecycle` | Add, dedupe, update, archive, delete, maintain, backfill |
| `consolidation` | Propose, execute, restore, delete |
| `engine` | State, facade, import, export |
| `tools` | Schemas, dispatch, origin checks |
| `api` | State, actions, trust checks, errors, size limits |

## Commands

| Command | Purpose |
|---|---|
| `npm test` | Run the full automated test suite |
| `npm run check` | Run static checks and linting |
| `node --test test/*.test.js` | Run the test files directly |

## Live verification

Live verification runs against the dedicated `her-memory-test` profile (see
`docs/verification-profile.md`) and covers the full user path. Run the steps in
order, and record the outcome of each step in the verification report so the
results are reproducible:

1. Install the plugin into the `her-memory-test` profile.
2. Open the settings page and confirm the plugin row is active.
3. Check the Memory settings entry renders in both English and Chinese.
4. Save the configuration and run the connectivity test against the configured
   backend.
5. Add, search, update, and archive memories through the API and the tools.
6. Run maintenance and confirm archive/stats behavior.
7. Generate a proposal, approve it, execute it, and restore it.
8. Export and import the memory store.
9. Verify that the four tools (`memory_search`, `memory_add`, `memory_update`,
   `memory_archive`) and the four skills (`her-memory`, `memory-recall`,
   `memory-capture`, `memory-curation`) are registered and usable by a real
   agent.
10. Confirm no slot crashes and that data is written under `$DSH_HOME/her-memory`.

### What cannot be verified without browser control

Some checks require an interactive browser and are reported explicitly rather
than silently skipped: visual layout of the settings tabs, sidebar rendering and
theme tokens, drag-and-drop or mouse interactions in the Curation tab, and
translation key fallback behavior in a live session. These are noted as manual
steps in the verification report rather than claimed as verified.

## Cleanup

After verification:

- Stop the 3090 background job that serves the `her-memory-test` profile.
- Do not touch the current web profile or the 3080 server.
- Remove temporary files and any test-generated proposals, snapshots, or
  memories created during the run.
