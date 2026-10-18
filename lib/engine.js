/**
 * Engine facade used by the host tools and the settings API.
 *
 * `createEngine()` never throws: initialization failures are captured in
 * `engine.initError` and the `ready` promise still resolves. Every data method
 * awaits `ready` and then either works or throws a structured
 * {@link HermemoryError}, which lets the settings page display and repair a bad
 * configuration instead of breaking the whole plugin.
 *
 * @module engine
 */

import {
  DEFAULT_CONFIG,
  DEFAULT_STATE,
  loadConfig,
  loadState,
  redactConfig,
  resolveHome,
  resolvePaths,
  saveConfig as writeConfig,
  saveState as writeState,
} from "./config.js";
import { createBackend } from "./embeddings.js";
import { HermemoryError, toError } from "./errors.js";
import {
  addMemory,
  archiveMemory,
  backfill as backfillMemories,
  deleteMemory,
  maintain as maintainStore,
  maybeAutoMaintain as runAutoMaintain,
  updateMemory,
} from "./lifecycle.js";
import { searchMemories } from "./retrieval.js";
import { JsonlStore } from "./store.js";
import { computeStamp, writeStamp } from "./version-stamp.js";
import {
  executeProposal,
  generateProposal,
  getProposal,
  listProposals,
  restoreProposal,
} from "./consolidation.js";
import {
  clamp,
  deepClone,
  deepMerge,
  isPlainObject,
  localIsoNow,
  newMemoryId,
  parseDate,
} from "./util.js";

/** Plugin identity exposed through `getState().plugin`. */
export const PLUGIN_INFO = Object.freeze({
  name: "@local/dsh-her-memory",
  version: "0.1.0",
});

/** Empty stats shape used when the store cannot be read. */
function emptyStats() {
  return {
    active: 0,
    archived: 0,
    pendingCompaction: 0,
    total: 0,
    fileSizeBytes: 0,
    corruptLines: 0,
    categories: [],
    types: [],
  };
}

/** Serialize entries as JSONL text. */
function toJsonlText(entries) {
  let output = "";
  for (const entry of entries) {
    output += `${JSON.stringify(entry)}\n`;
  }
  return output;
}

/** Case-insensitive filter comparison. */
function matchesFilter(value, filter) {
  return String(value ?? "").trim().toLowerCase() === filter;
}

/** Normalize an optional category/type filter. */
function normalizeFilter(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

/**
 * Engine facade.
 */
class Engine {
  /**
   * @param {object} [options]
   * @param {object|null} [options.ctx] DSH context.
   * @param {object|string|null} [options.config] Plugin row config (or a home path).
   * @param {object|null} [options.logger] Logger.
   * @param {object[]} [options.skills] Initial skills exposed through state.
   * @param {object[]} [options.tools] Initial tools exposed through state.
   */
  constructor({ ctx = null, config = null, logger = null, skills = [], tools = [] } = {}) {
    this.ctx = ctx;
    this.logger = logger;
    this.options = { ctx, config, logger };

    const configObject = config && typeof config === "object" ? config : null;
    const configuredHome =
      (configObject && typeof configObject.home === "string" && configObject.home) ||
      (typeof config === "string" ? config : "") ||
      "";

    /** Home directory selected by the plugin row config / `$DSH_HOME`. */
    this.home = resolveHome(configuredHome ? { home: configuredHome } : {});

    /** @type {object} */
    this.config = deepClone(DEFAULT_CONFIG);
    /** @type {ReturnType<typeof resolvePaths>} */
    this.paths = resolvePaths({ ...this.config, home: this.home });
    /** @type {JsonlStore} */
    this.store = new JsonlStore({ config: this.config, paths: this.paths, logger });
    /** @type {object} */
    this.backend = createBackend(this.config);
    /** @type {"none"|"unknown"|"ready"|"degraded"} */
    this.backendStatus = this.config.backend?.kind === "none" ? "none" : "unknown";
    /** @type {object|null} */
    this.state = null;
    /** @type {HermemoryError|null} */
    this.initError = null;
    /** @type {Error|null} */
    this._initErrorCause = null;

    this._skills = Array.isArray(skills) ? [...skills] : [];
    this._tools = Array.isArray(tools) ? [...tools] : [];
    this._initPromise = null;
    this._readySettled = false;
    this._maintenancePromise = null;
    this._autoMaintenancePromise = null;

    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });

    this.api = this._buildApi();

    // Start initialization without requiring the caller to await it. Failures
    // are captured inside init(), so this cannot produce an unhandled rejection.
    queueMicrotask(() => {
      this.init().catch(() => {});
    });
  }

  /** Bind public methods for `ctx.provide`. */
  _buildApi() {
    const names = [
      "getState",
      "getConfig",
      "saveConfig",
      "testBackend",
      "search",
      "add",
      "update",
      "archive",
      "list",
      "delete",
      "maintain",
      "backfill",
      "stamp",
      "propose",
      "listProposals",
      "getProposal",
      "executeProposal",
      "restoreProposal",
      "exportData",
      "importData",
    ];
    const api = {};
    for (const name of names) {
      api[name] = (...args) => this[name](...args);
    }
    return api;
  }

  /** Resolve the ready promise exactly once. */
  _settleReady() {
    if (this._readySettled) {
      return;
    }
    this._readySettled = true;
    this._resolveReady(this);
  }

  /**
   * Initialize (idempotently) and never throw.
   *
   * @returns {Promise<Engine>} This engine.
   */
  init() {
    if (!this._initPromise) {
      this._initPromise = (async () => {
        try {
          await this._doInit();
        } catch (error) {
          this.initError = toError(error);
          this._initErrorCause = error;
        } finally {
          this._settleReady();
        }
        return this;
      })();
    }
    return this._initPromise;
  }

  /** Best-effort initialization that records recoverable failures. */
  async _doInit() {
    try {
      this.config = await loadConfig({ home: this.home });
    } catch (error) {
      this.initError = toError(error);
      this._initErrorCause = error;
      this.config = deepClone(DEFAULT_CONFIG);
    }

    this.paths = resolvePaths({ ...this.config, home: this.home });
    this.store = new JsonlStore({ config: this.config, paths: this.paths, logger: this.logger });

    try {
      await this.store.ensureDirs();
    } catch (error) {
      if (!this.initError) {
        this.initError = toError(error);
        this._initErrorCause = error;
      }
    }

    try {
      this.state = await loadState({ home: this.home });
    } catch {
      this.state = deepClone(DEFAULT_STATE);
    }

    try {
      this.backend = createBackend(this.config);
    } catch (error) {
      if (!this.initError) {
        this.initError = toError(error);
        this._initErrorCause = error;
      }
      this.backend = createBackend({ kind: "none" });
    }

    if (this.initError) {
      this.backendStatus = "unknown";
    } else {
      this.backendStatus = this.config.backend?.kind === "none" ? "none" : "unknown";
    }

    return this;
  }

  /** Throw the captured init error (or a generic one) before data operations. */
  async _ensureUsable() {
    await this.ready;
    if (this.initError) {
      throw this.initError;
    }
    if (!this.store) {
      throw new HermemoryError("STORE_IO", "Memory store is not initialized", {
        status: 500,
      });
    }
    return this;
  }

  /** Mark a configured backend degraded after an embedding transport/parse failure. */
  _markBackendDegraded() {
    if (this.config.backend?.kind !== "none") {
      this.backendStatus = "degraded";
    }
  }

  /** Downgrade backend status when search reported an embedding request failure. */
  _markBackendDegradedFromWarnings(warnings) {
    if (this.config.backend?.kind === "none" || !Array.isArray(warnings)) {
      return;
    }
    if (warnings.some((warning) => String(warning).startsWith("Embedding backend"))) {
      this.backendStatus = "degraded";
    }
  }

  /**
   * Read the state file.
   *
   * @returns {Promise<object>}
   */
  async readState() {
    try {
      this.state = await loadState({ home: this.home });
    } catch {
      if (!this.state) {
        this.state = deepClone(DEFAULT_STATE);
      }
    }
    return this.state;
  }

  /**
   * Merge a patch into the state file.
   *
   * @param {object} patch State fields to update.
   * @returns {Promise<object>} Saved state.
   */
  async saveState(patch) {
    const current = await this.readState();
    const merged = deepMerge(current, patch);
    this.state = await writeState(merged, { home: this.home });
    return this.state;
  }

  /** Record an error in `state.lastError` without masking the original. */
  async _recordError(error) {
    try {
      const wrapped = toError(error);
      await this.saveState({
        lastError: {
          code: wrapped.code,
          message: wrapped.message,
          at: localIsoNow(),
        },
      });
    } catch {
      // State persistence is best-effort.
    }
  }

  /** Clear `state.lastError` after a successful operation. */
  async _clearError() {
    try {
      await this.saveState({ lastError: null });
    } catch {
      // State persistence is best-effort.
    }
  }

  /**
   * Return the stable state object used by the settings page.
   *
   * @returns {Promise<object>}
   */
  async getState() {
    await this.ready;

    let stats = emptyStats();
    try {
      if (this.store) {
        stats = await this.store.stats();
      }
    } catch {
      stats = emptyStats();
    }

    const state = (await this.readState()) || deepClone(DEFAULT_STATE);
    const config = this.config || deepClone(DEFAULT_CONFIG);
    const backendConfig = config.backend || DEFAULT_CONFIG.backend;

    return {
      plugin: { ...PLUGIN_INFO },
      config: redactConfig(config),
      paths: this.paths,
      stats,
      status: {
        backend: this.backendStatus,
        backendKind: backendConfig.kind,
        embeddingModel: backendConfig.embedding?.model ?? "",
        chatModel: backendConfig.chat?.model ?? "",
        lastMaintenance: state.lastMaintenance ?? null,
        lastBackfill: state.lastBackfillAt ?? null,
        lastProposal: state.lastProposalAt ?? null,
        lastError: this.initError
          ? this.initError.toJSON()
          : state.lastError ?? null,
      },
      skills: [...this._skills],
      tools: [...this._tools],
      capabilities: { skills: true, prompt: true, webApi: true },
    };
  }

  /**
   * Return the redacted configuration.
   *
   * @returns {Promise<object>}
   */
  async getConfig() {
    await this.ready;
    return redactConfig(this.config || DEFAULT_CONFIG);
  }

  /**
   * Replace skills exposed through state (integration helper).
   *
   * @param {object[]} skills Skills.
   * @returns {Engine}
   */
  setSkills(skills) {
    this._skills = Array.isArray(skills) ? [...skills] : [];
    return this;
  }

  /**
   * Replace tools exposed through state (integration helper).
   *
   * @param {object[]} tools Tools.
   * @returns {Engine}
   */
  setTools(tools) {
    this._tools = Array.isArray(tools) ? [...tools] : [];
    return this;
  }

  /**
   * Persist a configuration patch, rebuild the store/backend, and return state.
   *
   * This works even when the previous `config.json` was invalid, so the
   * settings page can repair it.
   *
   * @param {object} patch Partial configuration.
   * @returns {Promise<object>} Fresh state.
   */
  async saveConfig(patch) {
    await this.ready;
    const saved = await writeConfig(patch, { home: this.home });
    this.config = saved;
    this.paths = resolvePaths({ ...saved, home: this.home });
    const store = new JsonlStore({ config: saved, paths: this.paths, logger: this.logger });
    this.store = store;

    try {
      await store.ensureDirs();
    } catch (error) {
      const wrapped = toError(error);
      this.initError = wrapped;
      this._initErrorCause = error;
      await this._recordError(wrapped);
      throw wrapped;
    }

    this.backend = createBackend(saved);
    this.backendStatus = saved.backend?.kind === "none" ? "none" : "unknown";
    this.initError = null;
    this._initErrorCause = null;
    await this._clearError();
    return this.getState();
  }

  /**
   * Probe the configured backend without throwing.
   *
   * @param {object} [input]
   * @param {boolean} [input.chat=true] Probe chat too.
   * @returns {Promise<object>}
   */
  async testBackend({ chat = true } = {}) {
    await this._ensureUsable();
    const report = await this.backend.test({ chat });
    if (this.config.backend?.kind === "none") {
      this.backendStatus = "none";
    } else {
      this.backendStatus = report.ok ? "ready" : "degraded";
    }
    return report;
  }

  /** Load entries for search/list. */
  async _loadEntries(includeArchived) {
    if (includeArchived) {
      const active = await this.store.loadActive({ includeArchived: true });
      const archived = await this.store.loadArchive();
      return [...active, ...archived];
    }
    return this.store.loadActive();
  }

  /** Apply category/type filters. */
  _filterEntries(entries, category, type) {
    const categoryFilter = normalizeFilter(category);
    const typeFilter = normalizeFilter(type);
    if (!categoryFilter && !typeFilter) {
      return entries;
    }
    return entries.filter((entry) => {
      if (categoryFilter && !matchesFilter(entry.category, categoryFilter)) {
        return false;
      }
      if (typeFilter && !matchesFilter(entry.type, typeFilter)) {
        return false;
      }
      return true;
    });
  }

  /**
   * Cap the total text characters returned by a search.
   *
   * This is the engine-side enforcement of `search.maxResultChars`. Items are
   * kept in rank order; the last item may be truncated so at least part of a
   * long fact survives instead of producing an empty result set.
   */
  _applyResultBudget(results) {
    const configured = this.config.search?.maxResultChars;
    const budget = Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 6000;
    let remaining = budget;
    const kept = [];
    for (const item of results) {
      if (remaining <= 0) {
        break;
      }
      const text = typeof item.text === "string" ? item.text : "";
      if (text.length > remaining) {
        kept.push({ ...item, text: text.slice(0, remaining) });
        remaining = 0;
        break;
      }
      kept.push(item);
      remaining -= text.length;
    }
    return kept;
  }

  /** Shared search implementation with optional top-k clamping. */
  async _searchEntries({
    query = "",
    topK,
    category,
    type,
    includeArchived = false,
    signal,
    clampToMax = true,
    logHits = true,
  } = {}) {
    if (typeof query !== "string") {
      throw new HermemoryError("INVALID_INPUT", "query must be a string", {
        status: 400,
        details: { path: "query" },
      });
    }

    const config = this.config;
    const configuredDefault = Number.isInteger(config.search?.defaultTopK)
      ? config.search.defaultTopK
      : 8;
    const configuredMax = Number.isInteger(config.search?.maxTopK)
      ? config.search.maxTopK
      : 20;
    const requested = Number.isFinite(topK) ? Math.floor(topK) : configuredDefault;
    const effectiveTopK = clampToMax
      ? clamp(requested, 0, configuredMax)
      : Math.max(0, requested);

    const entries = this._filterEntries(
      await this._loadEntries(includeArchived === true),
      category,
      type,
    );

    const result = await searchMemories({
      entries,
      query,
      topK: effectiveTopK,
      minSimilarity: Number.isFinite(config.search?.minSimilarity)
        ? config.search.minSimilarity
        : 0,
      rrfK: Number.isFinite(config.search?.rrfK) ? config.search.rrfK : 60,
      backend: this.backend,
      energyMax: Number.isFinite(config.maintenance?.energyMax)
        ? config.maintenance.energyMax
        : 5,
      includeArchived: includeArchived === true,
      signal,
    });

    result.results = this._applyResultBudget(result.results);

    const hitIds = result.results
      .map((item) => item.id)
      .filter((id) => typeof id === "string" && id);
    if (logHits !== false && hitIds.length > 0) {
      await this.store.logHits(hitIds);
    }
    this._markBackendDegradedFromWarnings(result.warnings);

    return result;
  }

  /**
   * Hybrid memory search.
   *
   * @param {object} input
   * @param {string} input.query Query text.
   * @param {number} [input.topK] Result limit (clamped to `search.maxTopK`).
   * @param {string} [input.category] Category filter.
   * @param {string} [input.type] Type filter.
   * @param {boolean} [input.includeArchived=false] Include archived entries.
   * @param {boolean} [input.logHits=true] Append results to the retrieval-hit log.
   * @param {AbortSignal} [input.signal] Cancellation signal.
   * @returns {Promise<{query: string, retrievalMode: string, results: object[], warnings: string[]}>}
   */
  async search({
    query = "",
    topK,
    category,
    type,
    includeArchived = false,
    logHits = true,
    signal,
  } = {}) {
    await this._ensureUsable();
    return this._searchEntries({
      query,
      topK,
      category,
      type,
      includeArchived,
      signal,
      clampToMax: true,
      logHits,
    });
  }

  /**
   * Add a memory.
   *
   * @param {object} input Lifecycle input.
   * @returns {Promise<object>}
   */
  async add(input = {}) {
    await this._ensureUsable();
    return addMemory(this.store, this.config, this.backend, input);
  }

  /**
   * Supersede a memory with an updated version.
   *
   * @param {object} input Lifecycle input.
   * @returns {Promise<object>}
   */
  async update(input = {}) {
    await this._ensureUsable();
    return updateMemory(this.store, this.config, this.backend, input);
  }

  /**
   * Archive a memory.
   *
   * @param {object} input Lifecycle input.
   * @returns {Promise<object>}
   */
  async archive(input = {}) {
    await this._ensureUsable();
    return archiveMemory(this.store, this.config, input);
  }

  /**
   * List or search memories with pagination.
   *
   * @param {object} input
   * @param {string} [input.query] Optional search query.
   * @param {string} [input.category] Category filter.
   * @param {string} [input.type] Type filter.
   * @param {boolean} [input.includeArchived=false] Include archived entries.
   * @param {number} [input.offset=0] Result offset.
   * @param {number} [input.limit] Page size (defaults to `ui.pageSize`).
   * @param {AbortSignal} [input.signal] Cancellation signal.
   * @returns {Promise<{items: object[], total: number, offset: number, limit: number}>}
   */
  async list({
    query = "",
    category,
    type,
    includeArchived = false,
    offset = 0,
    limit,
    signal,
  } = {}) {
    await this._ensureUsable();
    const pageSize = Number.isInteger(this.config.ui?.pageSize)
      ? this.config.ui.pageSize
      : 50;
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const safeLimit = Math.max(1, Math.floor(Number(limit) || pageSize));

    if (typeof query === "string" && query.trim()) {
      const result = await this._searchEntries({
        query,
        topK: 500,
        category,
        type,
        includeArchived,
        signal,
        clampToMax: false,
        logHits: false,
      });
      const items = result.results.slice(safeOffset, safeOffset + safeLimit);
      return {
        items,
        total: result.results.length,
        offset: safeOffset,
        limit: safeLimit,
      };
    }

    const entries = this._filterEntries(
      await this._loadEntries(includeArchived === true),
      category,
      type,
    );
    entries.sort((left, right) => {
      const leftTime = parseDate(left.timestamp);
      const rightTime = parseDate(right.timestamp);
      const leftValue = leftTime ? leftTime.getTime() : 0;
      const rightValue = rightTime ? rightTime.getTime() : 0;
      return rightValue - leftValue;
    });

    return {
      items: entries.slice(safeOffset, safeOffset + safeLimit),
      total: entries.length,
      offset: safeOffset,
      limit: safeLimit,
    };
  }

  /**
   * Permanently delete a memory (requires `confirm: true`).
   *
   * @param {object} input
   * @returns {Promise<object>}
   */
  async delete({ id, confirm } = {}) {
    await this._ensureUsable();
    return deleteMemory(this.store, this.config, { id, confirm });
  }

  /**
   * Run maintenance and record `lastMaintenance`.
   *
   * @param {object} [input]
   * @param {AbortSignal} [input.signal] Accepted for API symmetry.
   * @returns {Promise<object>}
   */
  async maintain(input = {}) {
    await this._ensureUsable();
    if (this._maintenancePromise) {
      return this._maintenancePromise;
    }

    this._maintenancePromise = (async () => {
      try {
        const result = await maintainStore(this.store, this.config);
        try {
          await this.saveState({ lastMaintenance: localIsoNow(), lastError: null });
        } catch (error) {
          if (this.logger?.warn) {
            this.logger.warn("Maintenance succeeded but state update failed", error);
          }
        }
        return result;
      } catch (error) {
        const wrapped = toError(error);
        await this._recordError(wrapped);
        throw wrapped;
      } finally {
        this._maintenancePromise = null;
      }
    })();

    return this._maintenancePromise;
  }

  /**
   * Run automatic maintenance if it is due. Deduplicated with concurrent calls.
   *
   * @returns {Promise<object|null>}
   */
  async maybeAutoMaintain() {
    if (this._autoMaintenancePromise) {
      return this._autoMaintenancePromise;
    }
    this._autoMaintenancePromise = (async () => {
      try {
        return await runAutoMaintain(this);
      } finally {
        this._autoMaintenancePromise = null;
      }
    })();
    return this._autoMaintenancePromise;
  }

  /**
   * Report whether auto maintenance is due without running it.
   *
   * @returns {Promise<boolean>}
   */
  async isMaintenanceDue() {
    await this.ready;
    if (this.initError) {
      return false;
    }
    if (this.config?.maintenance?.autoRun === false) {
      return false;
    }
    const state = await this.readState();
    const last = parseDate(state.lastMaintenance);
    const hours = Number.isFinite(this.config?.maintenance?.intervalHours)
      ? this.config.maintenance.intervalHours
      : 24;
    return !last || Date.now() - last.getTime() >= hours * 3600000;
  }

  /**
   * Fill missing embeddings.
   *
   * @param {object} [input]
   * @param {boolean} [input.all=false] Recompute existing vectors too.
   * @param {AbortSignal} [input.signal] Cancellation signal.
   * @returns {Promise<object>}
   */
  async backfill({ all = false, signal } = {}) {
    await this._ensureUsable();
    try {
      const result = await backfillMemories(this.store, this.config, this.backend, {
        all,
        signal,
      });
      if (result.failed > 0) {
        this._markBackendDegraded();
      }
      try {
        await this.saveState({ lastBackfillAt: localIsoNow(), lastError: null });
      } catch (error) {
        if (this.logger?.warn) {
          this.logger.warn("Backfill succeeded but state update failed", error);
        }
      }
      return result;
    } catch (error) {
      if (error?.code === "BACKEND_UNAVAILABLE" || error?.code === "EMBEDDING_FAILED") {
        this._markBackendDegraded();
      }
      const wrapped = toError(error);
      await this._recordError(wrapped);
      throw wrapped;
    }
  }

  /**
   * Recompute the content version stamp.
   *
   * @returns {Promise<object>}
   */
  async stamp() {
    await this._ensureUsable();
    return writeStamp(this.store);
  }

  /**
   * Generate a consolidation proposal.
   *
   * @param {object} [input]
   * @returns {Promise<object>}
   */
  async propose(input = {}) {
    await this._ensureUsable();
    return generateProposal(this.store, this.config, this.backend, this.logger);
  }

  /**
   * List proposal summaries.
   *
   * @returns {Promise<object[]>}
   */
  async listProposals() {
    await this._ensureUsable();
    return listProposals(this.store);
  }

  /**
   * Read one proposal.
   *
   * @param {string} id Proposal id.
   * @returns {Promise<object>}
   */
  async getProposal(id) {
    await this._ensureUsable();
    return getProposal(this.store, id);
  }

  /**
   * Execute a reviewed proposal.
   *
   * @param {object} input
   * @returns {Promise<object>}
   */
  async executeProposal(input = {}) {
    await this._ensureUsable();
    return executeProposal(this.store, this.config, this.backend, input);
  }

  /**
   * Restore the snapshot of an executed proposal.
   *
   * @param {string} id Proposal id.
   * @returns {Promise<object>}
   */
  async restoreProposal(id) {
    await this._ensureUsable();
    return restoreProposal(this.store, this.config, id);
  }

  /**
   * Export active and archived JSONL plus the current content stamp.
   *
   * @returns {Promise<{active: string, archived: string, version: object}>}
   */
  async exportData() {
    await this._ensureUsable();
    const active = await this.store.loadActive({ includeArchived: true });
    const archived = await this.store.loadArchive();
    const version = await computeStamp(this.store);
    return {
      active: toJsonlText(active),
      archived: toJsonlText(archived),
      version,
    };
  }

  /**
   * Import JSONL, skipping ids already present in either file.
   *
   * @param {object} input
   * @param {string} input.jsonl JSONL text.
   * @param {boolean} [input.backfill=false] Backfill embeddings after import.
   * @param {AbortSignal} [input.signal] Cancellation signal.
   * @returns {Promise<{imported: number, skipped: number, invalid: number, filled: number}>}
   */
  async importData({ jsonl, backfill: doBackfill = false, signal } = {}) {
    await this._ensureUsable();
    if (typeof jsonl !== "string") {
      throw new HermemoryError("INVALID_INPUT", "jsonl must be a string", {
        status: 400,
        details: { path: "jsonl" },
      });
    }

    const parsed = [];
    let invalid = 0;
    for (const line of jsonl.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        invalid += 1;
        continue;
      }
      if (!isPlainObject(entry) || typeof entry.text !== "string") {
        invalid += 1;
        continue;
      }
      parsed.push(entry);
    }

    let imported = 0;
    let skipped = 0;

    if (parsed.length > 0) {
      await this.store.snapshot("import data");

      await this.store.transaction(async (tx) => {
        const active = await tx.loadActive({ includeArchived: true });
        const archived = await tx.loadArchive();
        const ids = new Set();
        for (const entry of [...active, ...archived]) {
          if (entry && typeof entry.id === "string" && entry.id) {
            ids.add(entry.id);
          }
        }

        const accepted = [];
        for (const raw of parsed) {
          let id =
            typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : null;
          if (!id) {
            id = generateUniqueId(ids);
          }
          if (ids.has(id)) {
            skipped += 1;
            continue;
          }
          ids.add(id);
          accepted.push({ ...raw, id });
        }

        if (accepted.length > 0) {
          await tx.writeActive([...active, ...accepted]);
          await writeStamp(this.store);
          imported = accepted.length;
        }
      });
    }

    let filled = 0;
    if (doBackfill === true && imported > 0) {
      try {
        const result = await backfillMemories(this.store, this.config, this.backend, {
          all: false,
          signal,
        });
        filled = result.filled;
      } catch (error) {
        filled = 0;
        if (this.logger?.warn) {
          this.logger.warn("Import succeeded but embedding backfill failed", error);
        }
      }
    }

    return { imported, skipped, invalid, filled };
  }
}

/** Generate an id not present in the supplied set. */
function generateUniqueId(ids) {
  let id = newMemoryId();
  while (ids.has(id)) {
    id = newMemoryId();
  }
  return id;
}

/**
 * Create the shared engine.
 *
 * Never throws for configuration or environment problems; inspect
 * `engine.initError` or await `engine.ready` and call a method for a structured
 * error.
 *
 * @param {object} [options]
 * @param {object|null} [options.ctx] DSH context.
 * @param {object|string|null} [options.config] Plugin row config (or a home path).
 * @param {object|null} [options.logger] Logger.
 * @param {object[]} [options.skills] Initial skills.
 * @param {object[]} [options.tools] Initial tools.
 * @returns {Engine}
 */
export function createEngine(options = {}) {
  return new Engine(options);
}
