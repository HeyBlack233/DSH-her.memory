# Consolidation

Consolidation is the process that turns groups of closely related atomic memories
into a single merged memory, and that moves stale or low-energy memories into the
archive. In this plugin, consolidation is **proposal-based, human-approved, and
history-preserving**. It is never automatic: nothing is merged, archived, or
deleted without a human reviewing a generated proposal and explicitly approving
it.

## Design principles

| Principle | Meaning |
|---|---|
| Proposal-based | The plugin generates a written proposal describing every candidate merge, archive move, and skill suggestion. |
| Human-approved | Only the user can approve and execute a proposal, from the Curation tab. |
| History-preserving | A snapshot is taken before every execution, and executed proposals can be restored. |
| Never automatic | No background task runs consolidation, and a proposal never executes itself. |

## Triggers

Consolidation can be requested manually, or the plugin flags that consolidation
is due when any configured threshold is met:

| Trigger | Condition |
|---|---|
| Manual | The user requests consolidation from the Curation tab. |
| Active count | `active_count >= consolidation.triggerCount` |
| File size | `file_size_mb >= consolidation.triggerSizeMb` |
| Untouched | Days since the last consolidation run `>= consolidation.triggerDays` |

The thresholds live in the plugin configuration. Meeting a threshold only makes
a proposal available for review; it never applies changes by itself.

## Generation

Proposal generation runs through the following steps:

1. Load all active memories and group them by `type`.
2. For each memory, reuse the stored embedding when one exists; otherwise embed
   the text with the configured embedding backend.
3. Compute pairwise cosine similarity within each type group. A pair becomes a
   merge candidate when its similarity is above `typeThresholds[type]`.
4. Optionally, an LLM judge reviews the candidate pairs and answers YES/NO for
   each, capped at `maxJudgePairs`. If the LLM backend is unavailable, no merge
   groups are built — archive candidates are still proposed.
5. Build merge groups from the accepted pairs using union-find, so overlapping
   pairs collapse into a single group.
6. Set `proposed_text` to the text of the longest member initially; the user can
   edit it during review.
7. Collect archive candidates: memories whose energy is below
   `energyArchiveThreshold`, or whose days since `last_hit` exceed
   `maintenance.archiveDays`.
8. Collect skill candidates: general memories whose text contains technical
   keywords.
9. Write the proposal file and set its status to `pending_review`.

## Proposal file

Each proposal is stored as JSON at `_proposals/<id>.json` in the memories
directory:

| Field | Contents |
|---|---|
| `proposal_id` | Unique identifier for the proposal |
| `generated_at` | Timestamp of generation |
| `trigger_reason` | Which trigger fired |
| `current_stats` | `active_count`, `file_size_mb`, and `by_type` counts |
| `merge_groups` | Array of candidate merge groups (see below) |
| `archive_candidates` | Memories proposed for archiving |
| `skill_candidates` | Memories proposed for skill extraction |
| `summary` | Human-readable overview of the proposal |
| `status` | `pending_review`, `executed`, or `restored` |

Each merge group carries `group_id`, `type`, `merged_from`, `memories`,
`proposed_text`, `status`, and `similarity_max`. Archive candidates carry `id`,
`text`, `type`, `energy`, `days_unhit`, and `reason`. Skill candidates carry
`id`, `text`, and `reason`.

## Review and approval

The Curation tab lists proposals with status `pending_review`. To approve, the
user:

1. Selects the merge groups to accept.
2. Edits the merged text of each accepted group.
3. Selects which archive candidates to move to the archive file.
4. Clicks approve and execute.

This step is user-only: no agent and no automation can approve a proposal.

## Execution

Executing a proposal performs the following steps, in order:

1. Require the proposal status to be `pending_review`; anything else is rejected.
2. Take a snapshot of the current memory files.
3. Validate that every selected id exists in the active set.
4. Create a new memory for each accepted group, recording `merged_from`,
   `merge_date`, and `merge_proposal`.
5. Archive the old members of each group, marking each with `merged_into`
   pointing at the new memory.
6. Move the selected archive candidates from the active file to the archive
   file.
7. Write both the active and archive JSONL files atomically.
8. Update the proposal status to `executed`, record the results, and stamp the
   change.

An empty selection is rejected: at least one merge group or archive candidate
must be chosen.

## Restore

Restoration is available only for proposals with status `executed`:

1. Read the snapshot manifest for the proposal.
2. Restore both the active and archive JSONL files from that snapshot.
3. Mark the proposal as `restored` and stamp.

Because a snapshot is taken before every execution, restore returns the store to
its exact pre-execution state.

## Permanent delete

Permanent deletion is available only on the Settings page, is user-only, and has
no tool:

1. The request must include `confirm: true`.
2. A snapshot is taken first.
3. The memory is removed from the active or archive file as applicable.
4. The change is stamped.

## Differences from her.memory

| Aspect | her.memory | This plugin |
|---|---|---|
| Merged text | Fixed at generation | Editable during review |
| Provenance | None | DSH origin and provenance fields on merged memories |
| Destructive operations | None | Snapshots before execution, restore, and permanent delete |
| Consent model | Proposal + human approval | Same |

## Limits

- There is no background consolidation; nothing runs on a schedule.
- The optional LLM judge adds cost and is capped by `maxJudgePairs`.
- Semantic deduplication is only performed inside proposals, never as a
  standalone operation.
