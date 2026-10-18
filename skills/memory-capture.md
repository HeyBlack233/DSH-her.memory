# Memory Capture: Writing Durable Facts

## Atomicity

One entry, one self-contained fact. Split compound statements: "We migrated to Postgres and the CI runs on Monday" becomes two entries. Include who, what, and when so the entry makes sense months later. Avoid ambiguous pronouns; write "the user prefers X" rather than "they prefer X".

## Types

- general — a durable fact with no strong emotional or event character.
- event — something that happened at a point in time, e.g. "Moved the deployment to Fly.io in April".
- preference — a stated like, dislike, or habit, e.g. "Prefers tabs over spaces".
- emotional — how the user felt about something, e.g. "Was frustrated with the flaky test suite".

## Categories

Use these consistently:
- user_profile — stable facts about the user.
- shared_history — things that happened between you and the user.
- tech_lessons — technical conclusions and fixes.
- project — project-specific facts; always pair with projectKey.
- general — anything that fits nowhere else.

Free text is allowed for categories, but consistency makes recall work; when in doubt, use one of the standard five.

## Dates and Keys

- eventDate records when the fact happened; it differs from the recorded timestamp. Use eventDate for event-type entries so the timeline stays accurate.
- projectKey ties an entry to one project. For project lessons, always set it — it makes dedupe and grouping possible.
- dedupe is opt-in and only effective with projectKey. Use it when you suspect the fact may already exist for that project; it is not a substitute for searching first.

## Add, Update, or Archive

- Add a new fact when it is genuinely new.
- Update when the fact changed: memory_update archives the old entry and creates a linked replacement, preserving history.
- Archive when the user asks, or when a fact is superseded and the user agrees. Never duplicate; if a fact exists, update it.

## Examples

Good: "The user prefers Postgres over MySQL for new services" (preference, user_profile).
Good: "Deployed the scheduler to Fly.io on 2026-10-12" (event, project, projectKey "scheduler").
Bad: "He likes Postgres and we moved to Fly.io in April and CI is on Monday" (multiple facts, ambiguous pronoun).
Bad: "Something about the build" (no subject, no when, unsearchable).
Good: "Fixed: the scheduler needs EXTERNAL_AUTH_URL set or startup fails" (tech_lessons, projectKey "scheduler").
Bad: "Started debugging the scheduler port issue" (transient task state — do not store).

## Privacy

Store only durable facts the user explicitly shared. Never store transient task state, in-progress work, or secrets of any kind. If you are unsure whether a fact is sensitive or durable, ask the user before writing.

## Confirming

Confirm briefly after writing: "Noted" or "I've saved that". Do not echo metadata, ids, or long summaries, and do not confirm every small entry in a chain of shared facts — one short acknowledgment is enough.
