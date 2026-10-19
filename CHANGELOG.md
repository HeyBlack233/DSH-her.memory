# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Highlights

<!-- Placeholder on the dev branch. Replace at release time. -->

### Added

- Initial repository scaffolding: development guide, documentation index, and changelog.
- Native JavaScript her.memory engine: JSONL store with cross-process locking and atomic writes, hybrid BM25 + embedding retrieval fused with reciprocal rank fusion, energy and archive lifecycle, supersede chains, retrieval-hit logging, and content version stamps.
- Four model tools: `memory_search`, `memory_add`, `memory_update`, and `memory_archive`, with DSH session/tool provenance.
- Four runtime skills: `her-memory`, `memory-recall`, `memory-capture`, and `memory-curation`, plus a short system-prompt pointer.
- Localized settings sidebar page (`settings.section`) with Overview, Memories, Curation, and Settings tabs in English and Simplified Chinese.
- Proposal-based consolidation with editable merged text, snapshots, restore, and a user-only permanent delete.
- Plugin-owned `config.json` with live updates, backend adapters for Ollama, llama.cpp/OpenAI-compatible, and keyword-only mode, plus embedding backfill.
- Unit and integration tests with a local fake backend, and a separate `her-memory-test` verification profile workflow.
- GitHub Actions CI workflow that runs static checks and the full test suite on Node.js 22 and 24 when a release lands on `main`.
- Release automation: after CI succeeds on `main`, the top `CHANGELOG.md` entry is validated against `package.json`, tagged `v<version>`, and published as a GitHub Release titled `DSH-her.memory v<version>`.

### Changed

- The settings page and documentation now call the consolidation text-generation backend the "LLM" backend instead of "chat"/"对话". The configuration key remains `backend.chat` for compatibility with her.memory and the chat-completions wire shape.
- API error details in the settings page now render localized, field-level messages instead of raw English server text; unknown codes fall back to the localized generic error.

### Fixed

- The Memories tab no longer crashes the whole settings section: the copy-ID button referenced an undefined `title` binding.

### Contributors
