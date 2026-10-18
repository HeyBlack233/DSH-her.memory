# DSH her.memory

Persistent companion memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
based on [`her.memory`](https://github.com/runs-agents/her.memory).

The plugin stores atomic facts in a human-readable JSONL file, retrieves them
with BM25 + embedding hybrid ranking, and keeps history through supersede
chains and proposal-based consolidation. It adds four model tools, four
runtime skills, and a localized settings page to the DSH Web GUI.

## Requirements

- DeepSeek Harness with the Web GUI.
- Node.js 22 or newer.
- Optional: a local embedding/chat backend such as Ollama or llama.cpp. Without
  one, memory still works in keyword-only mode and embeddings can be backfilled
  later.

## Install

From a checkout of this repository, install the package into a profile:

```bash
dsh plugin --profile <profile> add /absolute/path/to/DSH-her.memory
```

The bundle patch inserts the `her-memory` plugin row. Restart the profile's Web
GUI after installation.

## Data

By default the plugin writes under `$DSH_HOME/her-memory/`:

```
config.json
state.json
memories/semantic_memories.jsonl
memories/archived_memories.jsonl
memories/_snapshots/
memories/_proposals/
```

`memoryDir` in `config.json` can point at an existing her.memory directory. The
plugin never writes data into its own package directory.

## Model access

Tools: `memory_search`, `memory_add`, `memory_update`, `memory_archive`.

Skills: `her-memory`, `memory-recall`, `memory-capture`, `memory-curation`.

The plugin does not inject memories automatically. The model loads a skill and
calls a tool when the task calls for it.

## Settings

Open DSH Settings, then choose **Memory** in the settings sidebar. The page has
four tabs: Overview, Memories, Curation, and Settings. All visible copy is
available in English and Simplified Chinese and follows the DSH locale.

## Development

```bash
npm test
npm run check
```

The test suite uses Node's built-in test runner and a local fake backend; no
model runtime is required.

## Verification

The repository includes a throwaway-profile workflow so the plugin can be
verified without touching the active web profile:

```bash
dsh --profile her-memory-test --from-default-profile web --dump-config
dsh plugin --profile her-memory-test add /absolute/path/to/DSH-her.memory
dsh --profile her-memory-test --port 3090 --no-open
```

Open the printed token URL, then open Settings and choose **Memory**. See
[`docs/verification-profile.md`](docs/verification-profile.md) for the checklist
and cleanup steps.

See `docs/README.md` for the documentation index.

## License

MIT. The her.memory-derived design is credited in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
