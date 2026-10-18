# Memory Recall: Searching and Interpreting Results

## When to Search

Search before answering questions about the user's history, preferences, prior decisions, past projects, or anything that depends on what happened before this conversation. Also search when the user asks "do you remember...", when you are about to write a fact that might already exist, and before updating or archiving an entry.

Do not search for generic knowledge you already have, for the current task's transient details, or when the user explicitly says not to. Do not search to look busy; search when a result could actually change your answer.

## Query Crafting

- Start broad, then narrow. A first broad query finds the region of memory; a second query with more specific wording and filters pins it down.
- Keep exact symbols verbatim. File names, port numbers, error codes, package names, and identifiers are literal and match strongly in the keyword search.
- Paraphrase in natural language. Phrase the query the way the user would say it, not a keyword salad.
- Run multiple queries when the answer could live in several places: one for the topic, one for the person, one for the project.
- Use the stable key [key] when you know one; it targets the linked chain of related entries.
- Filter by category or type when you expect the fact in a particular bucket, e.g. category "tech_lessons" for a setup fix, type "preference" for taste.

## Interpreting Results

- similarity is relative: 0.45 can be the best match in a small store, while 0.8 in a large store is a strong hit. Compare scores within the result set, not against an absolute threshold.
- energy reflects recency and use: high energy means recently added or frequently recalled; low energy means older or rarely touched. Prefer high-energy entries unless the question is historical.
- archived entries are historical. They appear only when you set includeArchived and should be treated as past states, not current facts.
- A warning such as keyword-only fallback means the result matched by literal words but not semantically. Treat it as a candidate, verify it before relying on it, and say so if you use it.

## Conflicts

When two entries disagree, surface both. Prefer the newer or more specific one, but never silently discard the other: tell the user what you found and ask which is current. If you cannot resolve, say so. Do not fabricate a compromise.

## Citing Naturally

Mention what you found in plain language: "From what you told me in March..." Do not quote ids or metadata. If you rely on an archived entry, say it is older.

## Empty Results

If nothing matches, say so and ask a clarifying question rather than guessing. Suggest how the user can help, e.g. a different wording or a category.

## Examples

Good query: "port conflict when starting the dev server for the scheduler"
Bad query: "server problem" (too vague — matches everything)

Good query: "[stable_key] deployment credentials location"
Bad query: "where did we put that thing" (unsearchable pronouns)

Changed fact example: the user says "my repo is on GitHub now". Search first; if an old entry says the repo is on GitLab, update it with memory_update instead of adding a duplicate, and note the change. If you cannot find the old entry, add the new fact and tell the user you replaced the old note.
