/**
 * Memory lifecycle: add, supersede/update, archive, permanent delete, daily
 * maintenance, embedding backfill, and automatic maintenance scheduling.
 *
 * All destructive rewrites run inside {@link JsonlStore#transaction} so the
 * cross-process lock covers the whole read-modify-write cycle.
 *
 * @module lifecycle
 */

import { loadState, saveState } from "./config.js";
import { HermemoryError } from "./errors.js";
import { writeStamp } from "./version-stamp.js";
import {
  clamp,
  isPlainObject,
  localIsoNow,
  newMemoryId,
  parseDate,
} from "./util.js";

/** @returns {number} Fresh energy from configuration. */
function initialEnergy(config) {
  const value = config?.maintenance?.energyInitial;
  return Number.isFinite(value) ? value : 2.0;
}

/** @returns {number} Energy ceiling from configuration. */
function maximumEnergy(config) {
  const value = config?.maintenance?.energyMax;
  return Number.isFinite(value) && value > 0 ? value : 5.0;
}

/** A backend can produce vectors only when it is enabled and implements embed. */
function backendUsable(backend) {
  return Boolean(
    backend &&
      backend.kind !== "none" &&
      typeof backend.embed === "function",
  );
}

/** Validate a numeric vector. */
function validVector(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

/**
 * Try to embed text, downgrading failures to warnings.
 *
 * @param {object|null} backend Backend adapter.
 * @param {string} text Text to embed.
 * @param {object} options
 * @param {AbortSignal} [options.signal] Cancellation signal.
 * @param {string[]} options.warnings Warning sink.
 * @param {string} [options.label] Label used in the warning.
 * @returns {Promise<number[]|null>}
 */
async function tryEmbed(backend, text, { signal, warnings, label = "Embedding" }) {
  if (!backendUsable(backend)) {
    return null;
  }
  try {
    const vector = await backend.embed(text, { signal });
    if (!validVector(vector)) {
      warnings.push(`${label} failed: backend returned an invalid vector`);
      return null;
    }
    return vector;
  } catch (error) {
    warnings.push(`${label} failed: ${error?.message || error}`);
    return null;
  }
}

/** Normalize a project key: trim + lowercase; empty becomes null. */
export function normalizeProjectKey(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized || null;
}

/** Memory types accepted from the tools and the Web API. */
export const MEMORY_TYPES = Object.freeze(["general", "event", "preference", "emotional"]);

/** Normalize a memory type. */
function normalizeType(value, fallback = "general", { validate = true } = {}) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new HermemoryError("INVALID_INPUT", "Memory type must be a string", {
      status: 400,
      details: { path: "type", allowed: MEMORY_TYPES },
    });
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  if (validate && !MEMORY_TYPES.includes(trimmed)) {
    throw new HermemoryError(
      "INVALID_INPUT",
      `Memory type must be one of ${MEMORY_TYPES.join(", ")}`,
      { status: 400, details: { path: "type", allowed: MEMORY_TYPES, value: trimmed } },
    );
  }
  return trimmed;
}

/** Normalize a category. */
function normalizeCategory(value, fallback = "general") {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return fallback;
}

/**
 * Normalize an event date to `YYYY-MM-DD`.
 *
 * @param {*} value Date, date string, `null`, or `undefined`.
 * @returns {string|null|undefined} Normalized date, `null` to clear, or
 *   `undefined` when the caller did not provide one.
 * @throws {HermemoryError} `INVALID_INPUT` for an unparseable value.
 */
export function normalizeEventDate(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === "") {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const parsed = parseDate(trimmed);
      if (parsed) {
        return trimmed;
      }
    }
  }
  const parsed = parseDate(value);
  if (!parsed) {
    throw new HermemoryError("INVALID_INPUT", "eventDate must be a valid date", {
      status: 400,
      details: { path: "eventDate", value: String(value) },
    });
  }
  return parsed.toISOString().slice(0, 10);
}

/**
 * Extract a `[topic_subtopic]` stable key from the start of the text.
 *
 * @param {string} text Memory text.
 * @returns {string|null} Key including brackets, or `null`.
 */
export function stableKeyFromText(text) {
  if (typeof text !== "string" || !text.startsWith("[")) {
    return null;
  }
  const closing = text.indexOf("]");
  if (closing < 0) {
    return null;
  }
  const key = text.slice(0, closing + 1);
  return key.length > 2 && key.length <= 40 ? key : null;
}

/** Generate an id that does not collide with the supplied id set. */
function uniqueId(ids) {
  let id = newMemoryId();
  let attempts = 0;
  while (ids.has(id) && attempts < 100) {
    id = newMemoryId();
    attempts += 1;
  }
  return id;
}

/** Collect ids from active + archive files. */
function collectIds(active, archive) {
  const ids = new Set();
  for (const entry of active) {
    if (entry && typeof entry.id === "string") ids.add(entry.id);
  }
  for (const entry of archive) {
    if (entry && typeof entry.id === "string") ids.add(entry.id);
  }
  return ids;
}

/** Case-insensitive category comparison. */
function sameCategory(left, right) {
  return String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
}

/** Case-insensitive project-key comparison. */
function sameProjectKey(left, right) {
  return normalizeProjectKey(left) === normalizeProjectKey(right);
}

/**
 * Add one atomic memory.
 *
 * @param {import("./store.js").JsonlStore} store Store.
 * @param {object} config Configuration.
 * @param {object|null} backend Embedding backend.
 * @param {object} input
 * @param {string} input.text Memory text (required, trimmed).
 * @param {string} [input.type="general"] Memory type.
 * @param {string} [input.category="general"] Category namespace.
 * @param {*} [input.eventDate] When the fact happened.
 * @param {string} [input.projectKey] Structured project key.
 * @param {boolean} [input.dedupe=false] Gate writes by project key + category.
 * @param {*} [input.origin] Provenance object (DSH session/tool).
 * @param {AbortSignal} [input.signal] Cancellation signal.
 * @returns {Promise<object>} `{added, id?, duplicateId, hasEmbedding, warnings}`.
 */
export async function addMemory(store, config, backend, input = {}) {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) {
    throw new HermemoryError("INVALID_INPUT", "Memory text must not be empty", {
      status: 400,
      details: { path: "text" },
    });
  }

  const type = normalizeType(input.type);
  const category = normalizeCategory(input.category);
  const projectKey = normalizeProjectKey(input.projectKey);
  const dedupe = input.dedupe === true;
  const warnings = [];

  if (dedupe && !projectKey) {
    warnings.push("dedupe was ignored because no projectKey was provided");
  }

  if (dedupe && projectKey) {
    const active = await store.loadActive();
    const duplicate = active.find(
      (entry) =>
        !entry.archived &&
        sameProjectKey(entry.project_key, projectKey) &&
        sameCategory(entry.category, category),
    );
    if (duplicate) {
      return {
        added: false,
        duplicateId: typeof duplicate.id === "string" ? duplicate.id : null,
        hasEmbedding: false,
        warnings,
      };
    }
  }

  let embedding = await tryEmbed(backend, text, {
    signal: input.signal,
    warnings,
    label: "Embedding",
  });

  const result = await store.transaction(async (tx) => {
    const active = await tx.loadActive({ includeArchived: true });
    const archive = await tx.loadArchive();

    if (dedupe && projectKey) {
      const duplicate = active.find(
        (entry) =>
          entry.archived !== true &&
          sameProjectKey(entry.project_key, projectKey) &&
          sameCategory(entry.category, category),
      );
      if (duplicate) {
        return {
          added: false,
          duplicateId: typeof duplicate.id === "string" ? duplicate.id : null,
          hasEmbedding: false,
          warnings,
        };
      }
    }

    const ids = collectIds(active, archive);
    const id = uniqueId(ids);
    const eventDate = normalizeEventDate(input.eventDate);
    const now = localIsoNow();
    const energy = initialEnergy(config);

    const entry = {
      id,
      text,
      type,
      category,
      timestamp: now,
      archived: false,
      energy,
      last_hit: now,
    };

    if (embedding) {
      entry.embedding = embedding;
    }
    const stableKey = stableKeyFromText(text);
    if (stableKey) {
      entry.stable_key = stableKey;
    }
    if (eventDate) {
      entry.event_date = eventDate;
    }
    if (projectKey) {
      entry.project_key = projectKey;
    }
    if (input.origin !== undefined) {
      entry.origin = input.origin;
    }

    await tx.writeActive([...active, entry]);
    await writeStamp(store);

    return {
      added: true,
      id,
      duplicateId: null,
      hasEmbedding: Boolean(embedding),
      warnings,
    };
  });

  return result;
}

/**
 * Supersede an active memory with an updated version.
 *
 * The old entry stays in the store as an archived, linked record; maintenance
 * later moves it into the archive file.
 *
 * @param {import("./store.js").JsonlStore} store Store.
 * @param {object} config Configuration.
 * @param {object|null} backend Embedding backend.
 * @param {object} input
 * @param {string} input.id Id of the active memory to update.
 * @param {string} [input.text] Replacement text.
 * @param {string} [input.type] Replacement type.
 * @param {string} [input.category] Replacement category.
 * @param {*} [input.eventDate] Replacement event date.
 * @param {*} [input.origin] Provenance for the new version.
 * @param {AbortSignal} [input.signal] Cancellation signal.
 * @returns {Promise<object>} `{updated, oldId, newId, hasEmbedding, warnings}`.
 */
export async function updateMemory(store, config, backend, input = {}) {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) {
    throw new HermemoryError("INVALID_INPUT", "Memory id is required", {
      status: 400,
      details: { path: "id" },
    });
  }

  const fields = ["text", "type", "category", "eventDate"];
  const provided = fields.filter((field) => input[field] !== undefined);
  if (provided.length === 0) {
    throw new HermemoryError(
      "INVALID_INPUT",
      "update requires at least one of text, type, category, or eventDate",
      { status: 400, details: { path: fields.join("|") } },
    );
  }

  const existingActive = await store.loadActive({ includeArchived: true });
  const existing = existingActive.find((entry) => entry.id === id && entry.archived !== true);
  if (!existing) {
    throw new HermemoryError("NOT_FOUND", `Active memory not found: ${id}`, {
      status: 404,
      details: { id },
    });
  }

  const newText =
    input.text !== undefined
      ? typeof input.text === "string"
        ? input.text.trim()
        : ""
      : String(existing.text ?? "").trim();
  if (!newText) {
    throw new HermemoryError("INVALID_INPUT", "Memory text must not be empty", {
      status: 400,
      details: { path: "text" },
    });
  }

  const newType =
    input.type !== undefined
      ? normalizeType(input.type, existing.type || "general")
      : existing.type || "general";
  const newCategory =
    input.category !== undefined
      ? normalizeCategory(input.category, existing.category || "general")
      : existing.category || "general";
  const newEventDate =
    input.eventDate !== undefined ? normalizeEventDate(input.eventDate) : undefined;

  const warnings = [];
  let embedding = await tryEmbed(backend, newText, {
    signal: input.signal,
    warnings,
    label: "Embedding",
  });
  const textUnchanged = newText === String(existing.text ?? "").trim();
  if (!embedding && textUnchanged && validVector(existing.embedding)) {
    embedding = existing.embedding;
  }

  const result = await store.transaction(async (tx) => {
    const active = await tx.loadActive({ includeArchived: true });
    const archive = await tx.loadArchive();
    const index = active.findIndex((entry) => entry.id === id && entry.archived !== true);
    if (index < 0) {
      throw new HermemoryError("NOT_FOUND", `Active memory not found: ${id}`, {
        status: 404,
        details: { id },
      });
    }

    const oldEntry = active[index];
    const ids = collectIds(active, archive);
    const newId = uniqueId(ids);
    const now = localIsoNow();

    oldEntry.archived = true;
    oldEntry.superseded_by = newId;
    oldEntry.supersede_date = now;
    oldEntry.archive_date = now;
    oldEntry.archive_reason = `superseded:${newId}`;
    oldEntry._archive_note = `superseded by ${newId}`;

    const entry = {
      id: newId,
      text: newText,
      type: newType,
      category: newCategory,
      timestamp: now,
      archived: false,
      energy: Math.max(
        Number.isFinite(oldEntry.energy) ? oldEntry.energy : initialEnergy(config),
        initialEnergy(config),
      ),
      last_hit: now,
      supersedes: [id],
    };

    if (embedding) {
      entry.embedding = embedding;
    }
    const stableKey = stableKeyFromText(newText);
    if (stableKey) {
      entry.stable_key = stableKey;
    }

    const resolvedEventDate =
      newEventDate !== undefined ? newEventDate : oldEntry.event_date;
    if (resolvedEventDate) {
      entry.event_date = resolvedEventDate;
    }
    if (oldEntry.project_key) {
      entry.project_key = oldEntry.project_key;
    }
    if (input.origin !== undefined) {
      entry.origin = input.origin;
    } else if (oldEntry.origin !== undefined) {
      entry.origin = oldEntry.origin;
    }

    active[index] = oldEntry;
    active.push(entry);
    await tx.writeActive(active);
    await writeStamp(store);

    return {
      updated: true,
      oldId: id,
      newId,
      hasEmbedding: Boolean(embedding),
      warnings,
    };
  });

  return result;
}

/**
 * Archive a memory by marking it archived (maintenance moves it later).
 *
 * @param {import("./store.js").JsonlStore} store Store.
 * @param {object} config Configuration.
 * @param {object} input
 * @param {string} input.id Memory id.
 * @param {string} [input.reason] Human-readable archive reason.
 * @param {*} [input.origin] Provenance (accepted for API symmetry).
 * @returns {Promise<object>} `{archived: true, id}` or `{archived: false, alreadyArchived: true}`.
 */
export async function archiveMemory(store, config, { id, reason, origin } = {}) {
  const memoryId = typeof id === "string" ? id.trim() : "";
  if (!memoryId) {
    throw new HermemoryError("INVALID_INPUT", "Memory id is required", {
      status: 400,
      details: { path: "id" },
    });
  }

  return store.transaction(async (tx) => {
    const active = await tx.loadActive({ includeArchived: true });
    const archive = await tx.loadArchive();
    const index = active.findIndex((entry) => entry.id === memoryId);

    if (index >= 0 && active[index].archived === true) {
      return { archived: false, alreadyArchived: true };
    }
    if (index < 0) {
      if (archive.some((entry) => entry.id === memoryId)) {
        return { archived: false, alreadyArchived: true };
      }
      throw new HermemoryError("NOT_FOUND", `Memory not found: ${memoryId}`, {
        status: 404,
        details: { id: memoryId },
      });
    }

    const entry = active[index];
    entry.archived = true;
    entry.archive_date = localIsoNow();
    entry.archive_reason =
      typeof reason === "string" && reason.trim() ? reason.trim() : "archived by request";
    if (origin !== undefined) {
      entry.origin = origin;
    }

    await tx.writeActive(active);
    await writeStamp(store);
    return { archived: true, id: memoryId };
  });
}

/**
 * Permanently delete a memory from both files after taking a snapshot.
 *
 * @param {import("./store.js").JsonlStore} store Store.
 * @param {object} config Configuration.
 * @param {object} input
 * @param {string} input.id Memory id.
 * @param {boolean} input.confirm Must be exactly `true`.
 * @returns {Promise<{deleted: true, id: string}>}
 */
export async function deleteMemory(store, config, { id, confirm } = {}) {
  const memoryId = typeof id === "string" ? id.trim() : "";
  if (!memoryId) {
    throw new HermemoryError("INVALID_INPUT", "Memory id is required", {
      status: 400,
      details: { path: "id" },
    });
  }
  if (confirm !== true) {
    throw new HermemoryError("INVALID_INPUT", "Permanent delete requires confirm: true", {
      status: 400,
      details: { path: "confirm" },
    });
  }

  await store.snapshot(`delete memory ${memoryId}`);

  return store.transaction(async (tx) => {
    const active = await tx.loadActive({ includeArchived: true });
    const archive = await tx.loadArchive();
    const activeIndex = active.findIndex((entry) => entry.id === memoryId);
    const archiveIndex = archive.findIndex((entry) => entry.id === memoryId);
    if (activeIndex < 0 && archiveIndex < 0) {
      throw new HermemoryError("NOT_FOUND", `Memory not found: ${memoryId}`, {
        status: 404,
        details: { id: memoryId },
      });
    }
    if (activeIndex >= 0) {
      active.splice(activeIndex, 1);
    }
    if (archiveIndex >= 0) {
      archive.splice(archiveIndex, 1);
    }

    await tx.writeActive(active);
    await tx.writeArchive(archive);
    await writeStamp(store);
    return { deleted: true, id: memoryId };
  });
}

/**
 * Daily maintenance: settle hits, decay energy, move archived entries, and
 * archive entries that have not been hit for too long.
 *
 * The hit log is cleared only after both files have been written successfully,
 * so a crash can retry the same settlement next round.
 *
 * @param {import("./store.js").JsonlStore} store Store.
 * @param {object} config Configuration.
 * @returns {Promise<{
 *   active: number, archived: number, boosted: number, decayed: number,
 *   moved: number, archivedByAge: number,
 * }>}
 */
export async function maintain(store, config) {
  return store.transaction(async (tx) => {
    const hits = new Set(await store.drainHits({ keep: true }));
    const active = await tx.loadActive({ includeArchived: true });
    const archived = await tx.loadArchive();

    const now = new Date();
    const nowIso = localIsoNow();
    const maxEnergy = maximumEnergy(config);
    const initial = initialEnergy(config);
    const decay = Number.isFinite(config?.maintenance?.energyDecay)
      ? config.maintenance.energyDecay
      : 0.97;
    const boost = Number.isFinite(config?.maintenance?.energyHitBoost)
      ? config.maintenance.energyHitBoost
      : 0.2;
    const archiveDays = Number.isFinite(config?.maintenance?.archiveDays)
      ? config.maintenance.archiveDays
      : 90;

    let boosted = 0;
    let decayed = 0;
    let moved = 0;
    let archivedByAge = 0;

    for (const entry of active) {
      if (typeof entry.id === "string" && hits.has(entry.id)) {
        const energy = Number.isFinite(entry.energy) ? entry.energy : initial;
        entry.energy = clamp(energy + boost, 0, maxEnergy);
        entry.last_hit = nowIso;
        boosted += 1;
      }
      const energy = Number.isFinite(entry.energy) ? entry.energy : initial;
      entry.energy = Math.max(0.1, energy * decay);
      decayed += 1;
    }

    const remaining = [];
    for (const entry of active) {
      if (entry.archived === true) {
        archived.push(entry);
        moved += 1;
        continue;
      }

      const lastHit = parseDate(entry.last_hit) || parseDate(entry.timestamp);
      if (lastHit) {
        const days = (now.getTime() - lastHit.getTime()) / 86400000;
        if (days > archiveDays) {
          const roundedDays = Math.max(0, Math.floor(days));
          entry.archived = true;
          entry.archive_date = nowIso;
          entry.archive_reason = `inactive for ${roundedDays} days`;
          archived.push(entry);
          archivedByAge += 1;
          continue;
        }
      }
      remaining.push(entry);
    }

    await tx.writeActive(remaining);
    await tx.writeArchive(archived);
    await store.clearHits();
    await writeStamp(store);

    return {
      active: remaining.length,
      archived: archived.length,
      boosted,
      decayed,
      moved,
      archivedByAge,
    };
  });
}

/**
 * Fill missing embeddings (or recompute all) after taking a snapshot.
 *
 * @param {import("./store.js").JsonlStore} store Store.
 * @param {object} config Configuration.
 * @param {object|null} backend Embedding backend.
 * @param {object} [input]
 * @param {boolean} [input.all=false] Recompute existing vectors too.
 * @param {AbortSignal} [input.signal] Cancellation signal.
 * @returns {Promise<{total: number, filled: number, skipped: number, failed: number, warnings: string[]}>}
 */
export async function backfill(store, config, backend, { all = false, signal } = {}) {
  if (!backendUsable(backend)) {
    throw new HermemoryError(
      "BACKEND_UNAVAILABLE",
      "Embedding backfill requires an enabled embedding backend",
      { status: 503, details: { kind: backend?.kind ?? "none" } },
    );
  }

  await store.snapshot("backfill embeddings");

  return store.transaction(async (tx) => {
    const active = await tx.loadActive({ includeArchived: true });
    const warnings = [];
    let filled = 0;
    let skipped = 0;
    let failed = 0;

    for (const entry of active) {
      const hasEmbedding = validVector(entry.embedding);
      if (hasEmbedding && all !== true) {
        skipped += 1;
        continue;
      }
      const text =
        typeof entry.text === "string"
          ? entry.text.trim()
          : typeof entry.content === "string"
            ? entry.content.trim()
            : "";
      if (!text) {
        skipped += 1;
        continue;
      }
      try {
        const vector = await backend.embed(text, { signal });
        if (!validVector(vector)) {
          failed += 1;
          warnings.push(
            `Embedding failed for ${entry.id || "entry"}: backend returned an invalid vector`,
          );
          continue;
        }
        entry.embedding = vector;
        filled += 1;
      } catch (error) {
        failed += 1;
        warnings.push(`Embedding failed for ${entry.id || "entry"}: ${error?.message || error}`);
      }
    }

    if (filled > 0) {
      await tx.writeActive(active);
      await writeStamp(store);
    }

    return { total: active.length, filled, skipped, failed, warnings };
  });
}

/**
 * Run maintenance when the configured interval has elapsed.
 *
 * Failures are logged and recorded in the state file; they never escape.
 *
 * @param {object} engine Engine facade exposing `ready`, `config`, `paths`,
 *   `maintain()`, and optionally `readState()`/`saveState()`.
 * @returns {Promise<object|null>} Maintenance result, or `null` when skipped.
 */
export async function maybeAutoMaintain(engine) {
  if (!engine || typeof engine.maintain !== "function") {
    return null;
  }
  try {
    await engine.ready;
    const autoRun = engine.config?.maintenance?.autoRun;
    if (autoRun === false) {
      return null;
    }

    const state =
      typeof engine.readState === "function"
        ? await engine.readState()
        : await loadState({ home: engine.paths?.home });
    const last = parseDate(state.lastMaintenance);
    const intervalHours = Number.isFinite(engine.config?.maintenance?.intervalHours)
      ? engine.config.maintenance.intervalHours
      : 24;
    if (last && Date.now() - last.getTime() < intervalHours * 3600000) {
      return null;
    }

    return await engine.maintain({});
  } catch (error) {
    try {
      if (engine.logger && typeof engine.logger.warn === "function") {
        engine.logger.warn("Automatic maintenance failed", error);
      }
    } catch {
      // Logging must not mask the original failure.
    }
    try {
      if (typeof engine.saveState === "function") {
        await engine.saveState({
          lastError: {
            code: error?.code || "UNKNOWN",
            message: error?.message || String(error),
            at: localIsoNow(),
          },
        });
      }
    } catch {
      // State recording is best-effort.
    }
    return null;
  }
}
