# Security and Privacy

This document describes how the plugin handles trust, secrets, memory data,
consent, and agent authority, and states the threat model the code defends
against.

## Trust model

The plugin exposes a local Host API under `/plugins/dsh-her-memory/api` inside
the DSH web server. Every request must pass the same-origin checks before it
reaches any handler:

| Check | Enforcement |
|---|---|
| `Sec-Fetch-Site` | Requests whose site is `cross-site` are rejected |
| `Origin` vs Host | The `Origin` header must match the DSH Host origin |
| Content type | The request body must be JSON |
| Body size | Bodies larger than 25 MiB are rejected with a size error |

The API has no remote authentication token of its own: it trusts the DSH web
server, which binds to `localhost` by default. The localhost binding is therefore
the effective security boundary, and the same-origin checks are what keep other
web pages from driving the API.

## Secrets

Embedding and chat backend API keys are stored in `config.json` in the plugin
home:

- The file is created with `0600` permissions where the platform supports them.
- Keys are redacted in every API and state response: clients only ever see the
  boolean `apiKeySet`.
- Keys are never returned to the client once stored, and never written to logs.
- A clear-key flow lets the user remove a stored key without editing the file by
  hand.

Redaction exists to protect against accidental exposure through state dumps, API
responses, or debug output; only the presence of a key is ever disclosed.

## Memory data

- Memories are stored as human-readable JSONL files that the user owns.
- Files are created with `0600` permissions where supported.
- Snapshots preserve the exact store state before destructive operations
  (consolidation execution, restore, and permanent delete).
- Storage is local-first. The only text that leaves the machine is the memory
  content sent to the configured embedding or chat backend; no other service
  receives it.

### Data flow summary

| Operation | Data read | Data sent externally |
|---|---|---|
| Search | Local JSONL and stored embeddings | Query text to the embedding backend |
| Add / update | Local JSONL | New text to the embedding backend |
| Consolidation judge | Candidate pair texts | Candidate pairs to the chat backend |

## Consent

- There is no automatic capture: a memory is created only by an explicit
  `memory_add` tool call.
- The tools act on explicit requests from the user or from an agent the user
  controls.
- The skills teach privacy rules, including what kind of information belongs in
  memory and what does not.
- Archive is reversible; permanent delete is not. The UI states the difference.
- Permanent delete is user-only and requires an explicit `confirm: true`.

## Agent authority

| Operation | Agents | User only |
|---|---|---|
| `memory_add`, `memory_update`, `memory_archive` | Yes | — |
| Consolidation (propose / execute) | No | Yes |
| Restore | No | Yes |
| Change configuration | No | Yes |
| Export / import | No | Yes |
| Permanent delete | No | Yes |

Agents can add, update, and archive memories, but they cannot consolidate,
restore, reconfigure, move data in or out of the store, or delete anything
permanently.

## Threat model

| Threat | Mitigation |
|---|---|
| Prompt injection via memory text | Memory text is untrusted data; retrieval treats it as content, never as instructions |
| Malicious imports | Imported records are validated before they enter the store |
| Path traversal via `memoryDir` | Absolute and relative paths are validated; `~` is never expanded |
| Oversized request bodies | 25 MiB cap enforced by the API |
| Concurrent writers | A file lock plus atomic writes serialize updates |
| Two processes sharing a store | A Python her.memory process and this plugin must never write the same directory concurrently |

## Out of scope

The following are intentionally out of scope for this local plugin:
multi-user authentication, encryption at rest, and hardening for remote
deployments.
