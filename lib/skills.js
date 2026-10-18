/**
 * Runtime skill registration.
 *
 * Skill bodies live in `skills/*.md` at the package root and are owned by the
 * documentation workstream. Missing or unreadable bodies are reported and
 * skipped so a packaging mistake cannot prevent the plugin from activating.
 *
 * @module @local/dsh-her-memory/skills
 */

import { readFileSync } from "node:fs";

/** The four runtime skills and the package-relative body file for each. */
const SKILLS = [
  {
    name: "her-memory",
    file: "her-memory.md",
    description:
      "Persistent companion memory: when to recall facts about the user, how to record new ones, and how to keep memory trustworthy.",
    whenToUse:
      "Use when the user references past conversations, preferences, personal facts, or asks what you remember; also before recording a durable fact."
  },
  {
    name: "memory-recall",
    file: "memory-recall.md",
    description: "How to search persistent memory effectively and interpret retrieved facts.",
    whenToUse:
      "Use before answering questions that depend on the user's history, preferences, or prior decisions."
  },
  {
    name: "memory-capture",
    file: "memory-capture.md",
    description:
      "How to write durable, atomic memories: type, category, dedupe, update versus archive, and privacy rules.",
    whenToUse:
      "Use when the user shares a durable fact, preference, event, or project lesson worth remembering."
  },
  {
    name: "memory-curation",
    file: "memory-curation.md",
    description:
      "How to review consolidation proposals, explain archival, and help the user curate memory without rewriting history.",
    whenToUse:
      "Use when the user asks about memory maintenance, consolidation, forgetting, or what is stored."
  }
];

/** Summaries of the skills this process has actually registered. */
const registeredSkills = new Set();

/** The static manifest, used before registration has run or when every file is missing. */
const MANIFEST_SUMMARIES = SKILLS.map(({ name, description }) => ({ name, description }));

/**
 * Return the registered skill summaries for the state API.
 *
 * When no skill has registered yet (for example while the settings page is
 * opened before activation completed), fall back to the static manifest so the
 * page can still describe the intended catalog.
 *
 * @returns one `{ name, description }` summary per skill, deduplicated by name.
 */
export function getRegisteredSkills() {
  const source = registeredSkills.size > 0 ? [...registeredSkills] : MANIFEST_SUMMARIES;
  const seen = new Set();
  const summaries = [];
  for (const skill of source) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    summaries.push({ name: skill.name, description: skill.description });
  }
  return summaries;
}

/** Report one skipped skill without failing activation. */
function warnSkip(ctx, message, error) {
  const detail = error instanceof Error ? error.message : String(error);
  if (typeof ctx.logger?.warn === "function") ctx.logger.warn(`[her-memory] ${message}: ${detail}`);
  else if (typeof console !== "undefined" && typeof console.warn === "function") console.warn(`[her-memory] ${message}: ${detail}`);
}

/**
 * Register the four runtime skills.
 *
 * The bodies are read once, during registration, from the package's `skills/`
 * directory. A skill whose file is missing or empty is skipped with a warning;
 * the remaining skills still register.
 *
 * @param ctx - registrant context carrying the skill registry.
 * @param engine - shared engine (unused by skills, kept for a uniform signature).
 * @returns the effect disposer that unregisters every registered skill.
 */
export function registerSkills(ctx, engine) {
  void engine;
  return ctx.effect(() => {
    const disposers = [];
    for (const skill of SKILLS) {
      let content;
      try {
        content = readFileSync(new URL(`../skills/${skill.file}`, import.meta.url), "utf8");
      } catch (error) {
        warnSkip(ctx, `skill body skills/${skill.file} is unavailable; skipping "${skill.name}"`, error);
        continue;
      }
      if (content.trim().length === 0) {
        warnSkip(ctx, `skill body skills/${skill.file} is empty; skipping "${skill.name}"`, new Error("empty skill body"));
        continue;
      }
      try {
        const dispose = ctx.skills.register({
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse,
          content,
          invocation: { modelInvocable: true, userInvocable: true },
          source: "runtime"
        });
        const summary = { name: skill.name, description: skill.description };
        registeredSkills.add(summary);
        disposers.push(() => {
          registeredSkills.delete(summary);
          if (typeof dispose === "function") dispose();
        });
      } catch (error) {
        warnSkip(ctx, `could not register skill "${skill.name}"`, error);
      }
    }
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  }, "her-memory: skills");
}
