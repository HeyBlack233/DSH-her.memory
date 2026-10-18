# Localization

Every user-visible string in the plugin's settings page is produced through a
translation key. The plugin ships English and Simplified Chinese and follows the
active DSH locale without a page reload.

## Namespace and key shape

The settings page registers its dictionaries under the `herMemory` namespace:

```js
ctx.effect(
  () => ctx.locale.register("herMemory", { en: EN, zh: ZH }),
  "her-memory: locale",
);
```

Keys are flat, dot-separated strings grouped by area:

| Group | Examples |
|---|---|
| `nav` | `nav.label` |
| `page` | `page.title`, `page.subtitle`, `page.lastErrorTitle` |
| `tabs` | `tabs.overview`, `tabs.memories`, `tabs.curation`, `tabs.settings` |
| `overview` | `overview.statsActive`, `overview.testConnection` |
| `memories` | `memories.searchPlaceholder`, `memories.empty`, `memories.archive` |
| `curation` | `curation.propose`, `curation.mergeGroups`, `curation.confirmExecute` |
| `settings` | `settings.connectionTitle`, `settings.storageDesc` |
| `status` | `status.ready`, `status.degraded`, `status.unknown` |
| `actions` | `actions.save`, `actions.refresh`, `actions.cancel` |
| `fields` | `fields.embeddingUrl`, `fields.defaultTopK` |
| `errors` | `errors.INVALID_INPUT`, `errors.BACKEND_UNAVAILABLE` |
| `confirm` | `confirm.delete`, `confirm.execute` |
| `empty` | `empty.memoriesTitle`, `empty.proposals` |
| `aria` | `aria.tabs`, `aria.refresh`, `aria.pagination` |

Use `{name}` placeholders for interpolation; the locale service replaces them
with the matching parameter (`t("curation.proposalCount", { count })`). Do not
build sentences by concatenating translated fragments; keep each sentence a
single key.

## English and Chinese resources

`client.js` contains two complete dictionaries, `EN` and `ZH`. Every key used by
the page must exist in both. The page falls back to the key itself only if a
lookup is missing, which is a defect, not a design feature.

The two JSON files under `locale/` carry only plugin-inventory metadata:

```json
{
  "meta": {
    "title": "Her Memory",
    "description": "Persistent companion memory with a human-readable JSONL store, hybrid retrieval, and proposal-based consolidation."
  }
}
```

`locale/zh.json` supplies the Chinese title and description. These files are
read by Plugin Manager and Settings without activating the plugin; they are not
the UI dictionary. The full UI dictionary lives in the client bundle so the
settings page can translate without another network request.

## Locale wiring

The section registration supplies both the sidebar label and the page's `t`
reader:

- `label: () => ctx.locale.bind("herMemory")("nav.label")` is a thunk, so the
  shell re-reads it on every projection. A language switch updates the sidebar
  entry without re-registering the section.
- `locale: "herMemory"` injects a `t` prop into the component. The slot system
  re-renders the entry when the active locale changes, so the page body follows
  the switch without a reload.
- Dates, numbers, and byte sizes use `Intl` with
  `document.documentElement.lang` (the locale service keeps `<html lang>` in
  sync). Memory text is never translated; it is user content.
- The dictionaries are registered in an effect and removed when the plugin
  unloads.

## API errors

The primary sentence comes from the `errors.<CODE>` dictionary. Validation
errors (`INVALID_INPUT`) carry a `details.path` and, for config and lifecycle
checks, a machine-stable `details.reason`. The page maps both through
`FIELD_LABEL_KEYS` and `reasonText` so the user sees a localized sentence such as
"Default top K must not exceed the maximum top K" rather than the host's English
message.

Raw `error.message` text is never rendered in the settings page. Codes without a
dictionary entry fall back to `errors.UNKNOWN`; non-validation diagnostics stay
in the host console/log. When adding a new validation error on the host side,
give it a stable `details.reason` and add an `errors.detail.reason.*` key to both
dictionaries.

## Model-facing text

Tool descriptions, tool result text, skill bodies, and the system-prompt pointer
are English model instructions. They are not part of the UI translation system.
The skills tell the model to reply in the user's language and to store memory
text in the language the user used.

Memory records themselves are user content and may be in any language. The
retrieval tokenizer handles mixed English and CJK text; the UI displays the
stored text verbatim.

## Adding a language

1. Add a complete dictionary to `client.js` with the same key set as `EN` and
   `ZH`.
2. Register it in the `ctx.locale.register("herMemory", { en, zh, ... })` call.
3. Add a `locale/<id>.json` with `meta.title` and `meta.description` if the
   plugin inventory should show localized metadata.
4. Check that every key exists in the new dictionary and that no user-visible
   string remains hard-coded.

The locale service validates BCP 47-style ids and requires an `en` fallback.

## Auditing for hard-coded strings

Before finishing a UI change:

- Search the component tree for quoted English or Chinese text outside the `EN`
  and `ZH` objects. Only technical values (URLs, ids, CSS class names, ARIA
  roles, `role="status"` and similar attributes) may be literal.
- Check every `placeholder`, `aria-label`, `title`, empty state, confirmation,
  and error sentence goes through `t(...)`.
- Compare the `EN` and `ZH` key sets; they must be identical.
- Exercise the page in both languages, including the sidebar label, and switch
  languages while the page is open.
- Confirm API error codes map to `errors.<CODE>` keys and that an unknown code
  falls back to `errors.UNKNOWN`, never to the raw server message. Check that a
  new validation reason has a matching `errors.detail.reason.*` key in both
  dictionaries.
