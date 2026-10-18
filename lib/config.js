/**
 * Defaults, configuration IO, validation, redaction, and the state file.
 *
 * `config.json` is plugin-owned. It is deep-merged over {@link DEFAULT_CONFIG}
 * on load, so unknown keys written by a newer version survive an older one.
 * API keys never leave the host through {@link redactConfig}.
 *
 * @module config
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { HermemoryError } from "./errors.js";
import { HOME_TAG, resolveHome, resolvePaths } from "./paths.js";
import { atomicWrite, deepClone, deepMerge, isPlainObject, readJson } from "./util.js";

/**
 * Default configuration. Kept as a plain JSON object on purpose: it is also the
 * initial content of a freshly created `config.json`.
 *
 * @type {object}
 */
export const DEFAULT_CONFIG = {
  schemaVersion: 1,
  memoryDir: null,
  backend: {
    kind: "none",
    embedding: {
      url: "http://127.0.0.1:11434/api/embeddings",
      model: "bge-m3",
      apiKey: "",
      timeoutMs: 15000,
    },
    chat: {
      url: "http://127.0.0.1:11434/api/generate",
      model: "qwen2.5:7b",
      apiKey: "",
      timeoutMs: 30000,
    },
  },
  search: {
    defaultTopK: 8,
    maxTopK: 20,
    minSimilarity: 0,
    maxResultChars: 6000,
    rrfK: 60,
  },
  maintenance: {
    autoRun: true,
    intervalHours: 24,
    energyInitial: 2.0,
    energyDecay: 0.97,
    energyMax: 5.0,
    energyHitBoost: 0.2,
    archiveDays: 90,
  },
  consolidation: {
    triggerCount: 100,
    triggerSizeMb: 2.5,
    triggerDays: 30,
    typeThresholds: {
      preference: 0.9,
      event: 0.8,
      emotional: 0.75,
      general: 0.8,
    },
    energyArchiveThreshold: 0.5,
    llmJudge: true,
    maxJudgePairs: 60,
  },
  ui: { pageSize: 50 },
};

/** Default contents of `state.json`. */
export const DEFAULT_STATE = {
  schemaVersion: 1,
  lastMaintenance: null,
  lastProposalAt: null,
  lastBackfillAt: null,
  lastError: null,
};

/** Backend kinds accepted by the configuration validator. */
export const BACKEND_KINDS = Object.freeze([
  "ollama",
  "llama-cpp",
  "openai-compatible",
  "none",
]);

/**
 * Non-enumerable marker that remembers which home directory a loaded object
 * came from. It keeps `saveConfig(patch)` writes in the same home without
 * persisting an internal path into the user's JSON.
 */
const HOME_SYMBOL = HOME_TAG;

/**
 * Most recent home passed to a load/save helper. It lets parameterless
 * `saveConfig(patch)` / `saveState(state)` calls stay in the home a caller just
 * loaded, instead of silently falling back to the process default.
 *
 * @type {string|null}
 */
let lastUsedHome = null;

/** Remember the home used by the latest load or save. */
function rememberHome(home) {
  lastUsedHome = home;
  return home;
}

/**
 * Return the home directory a loaded configuration/state object came from.
 *
 * @param {object} value Object returned by {@link loadConfig} or {@link loadState}.
 * @returns {string|null}
 */
export function getConfigHome(value) {
  return value && typeof value === "object" ? value[HOME_SYMBOL] || null : null;
}

/** @returns {string} Absolute home for load/save options. */
function optionHome(options = {}, env = process.env) {
  if (options && typeof options.home === "string" && options.home.trim()) {
    return path.resolve(options.home.trim());
  }
  return resolveHome({}, env);
}

/**
 * Attach the source home as a non-enumerable marker.
 *
 * @template T
 * @param {T} value Object to tag.
 * @param {string} home Source home.
 * @returns {T}
 */
function tagHome(value, home) {
  rememberHome(home);
  if (value && typeof value === "object") {
    Object.defineProperty(value, HOME_SYMBOL, {
      value: home,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }
  return value;
}

/**
 * Throw an INVALID_INPUT error carrying the JSON path of the bad value.
 *
 * @param {string} jsonPath Dotted JSON path.
 * @param {string} reason Human-readable reason.
 * @returns {never}
 */
function invalid(jsonPath, reason) {
  throw new HermemoryError(
    "INVALID_INPUT",
    `Invalid configuration at ${jsonPath || "<root>"}: ${reason}`,
    { status: 400, details: { path: jsonPath || "", reason } },
  );
}

/** Assert a finite number within an inclusive range. */
function numberIn(value, jsonPath, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(jsonPath, "expected a finite number");
  }
  if (integer && !Number.isInteger(value)) {
    invalid(jsonPath, "expected an integer");
  }
  if (value < min || value > max) {
    invalid(jsonPath, `expected a value between ${min} and ${max}`);
  }
}

/** Assert a non-empty string. */
function nonEmptyString(value, jsonPath) {
  if (typeof value !== "string" || !value.trim()) {
    invalid(jsonPath, "expected a non-empty string");
  }
}

/** Assert a boolean. */
function booleanValue(value, jsonPath) {
  if (typeof value !== "boolean") {
    invalid(jsonPath, "expected a boolean");
  }
}

/**
 * Validate an embedding/chat endpoint block.
 *
 * When the backend is disabled, URL and model may be empty so the settings page
 * can clear fields without making the configuration unsavable. They are still
 * required as soon as a real backend kind is selected.
 */
function validateEndpoint(block, jsonPath, { allowEmpty = false } = {}) {
  if (!isPlainObject(block)) {
    invalid(jsonPath, "expected an object");
  }
  if (allowEmpty) {
    if (typeof block.url !== "string") {
      invalid(`${jsonPath}.url`, "expected a string");
    }
    if (typeof block.model !== "string") {
      invalid(`${jsonPath}.model`, "expected a string");
    }
  } else {
    nonEmptyString(block.url, `${jsonPath}.url`);
    nonEmptyString(block.model, `${jsonPath}.model`);
  }
  if (typeof block.apiKey !== "string") {
    invalid(`${jsonPath}.apiKey`, "expected a string");
  }
  numberIn(block.timeoutMs, `${jsonPath}.timeoutMs`, { min: 1 });
}

/**
 * Validate a full configuration object.
 *
 * Unknown keys are allowed and preserved. Known sections are checked strictly
 * so the settings page can report a stable JSON path instead of failing later.
 *
 * @param {object} config Configuration to validate.
 * @returns {object} The same object, for chaining.
 * @throws {HermemoryError} `INVALID_INPUT` with `details.path`.
 */
export function validateConfig(config) {
  if (!isPlainObject(config)) {
    invalid("", "configuration must be a plain object");
  }

  if (config.schemaVersion !== 1) {
    invalid("schemaVersion", "only schema version 1 is supported");
  }

  if (config.home !== undefined && config.home !== null) {
    nonEmptyString(config.home, "home");
  }

  if (config.memoryDir !== null && config.memoryDir !== undefined) {
    nonEmptyString(config.memoryDir, "memoryDir");
  }

  const backend = config.backend;
  if (!isPlainObject(backend)) {
    invalid("backend", "expected an object");
  }
  if (!BACKEND_KINDS.includes(backend.kind)) {
    invalid("backend.kind", `expected one of ${BACKEND_KINDS.join(", ")}`);
  }
  const endpointOptions = { allowEmpty: backend.kind === "none" };
  validateEndpoint(backend.embedding, "backend.embedding", endpointOptions);
  validateEndpoint(backend.chat, "backend.chat", endpointOptions);

  const search = config.search;
  if (!isPlainObject(search)) {
    invalid("search", "expected an object");
  }
  numberIn(search.maxTopK, "search.maxTopK", { min: 1, max: 10000, integer: true });
  numberIn(search.defaultTopK, "search.defaultTopK", { min: 1, integer: true });
  if (search.defaultTopK > search.maxTopK) {
    invalid("search.defaultTopK", "must not exceed search.maxTopK");
  }
  numberIn(search.minSimilarity, "search.minSimilarity", { min: 0, max: 1 });
  numberIn(search.maxResultChars, "search.maxResultChars", { min: 1, integer: true });
  numberIn(search.rrfK, "search.rrfK", { min: 1 });

  const maintenance = config.maintenance;
  if (!isPlainObject(maintenance)) {
    invalid("maintenance", "expected an object");
  }
  booleanValue(maintenance.autoRun, "maintenance.autoRun");
  numberIn(maintenance.intervalHours, "maintenance.intervalHours", { min: 1 });
  numberIn(maintenance.energyInitial, "maintenance.energyInitial", { min: 0 });
  numberIn(maintenance.energyDecay, "maintenance.energyDecay", { min: 0, max: 1 });
  if (maintenance.energyDecay === 0) {
    invalid("maintenance.energyDecay", "must be greater than zero");
  }
  numberIn(maintenance.energyMax, "maintenance.energyMax", { min: 0 });
  if (maintenance.energyMax === 0) {
    invalid("maintenance.energyMax", "must be greater than zero");
  }
  numberIn(maintenance.energyHitBoost, "maintenance.energyHitBoost", { min: 0 });
  numberIn(maintenance.archiveDays, "maintenance.archiveDays", { min: 0 });

  const consolidation = config.consolidation;
  if (!isPlainObject(consolidation)) {
    invalid("consolidation", "expected an object");
  }
  numberIn(consolidation.triggerCount, "consolidation.triggerCount", {
    min: 1,
    integer: true,
  });
  numberIn(consolidation.triggerSizeMb, "consolidation.triggerSizeMb", { min: 0 });
  numberIn(consolidation.triggerDays, "consolidation.triggerDays", { min: 0 });
  if (!isPlainObject(consolidation.typeThresholds)) {
    invalid("consolidation.typeThresholds", "expected an object");
  }
  for (const [name, threshold] of Object.entries(consolidation.typeThresholds)) {
    numberIn(
      threshold,
      `consolidation.typeThresholds.${name}`,
      { min: 0, max: 1 },
    );
  }
  numberIn(consolidation.energyArchiveThreshold, "consolidation.energyArchiveThreshold", {
    min: 0,
  });
  booleanValue(consolidation.llmJudge, "consolidation.llmJudge");
  numberIn(consolidation.maxJudgePairs, "consolidation.maxJudgePairs", {
    min: 1,
    integer: true,
  });

  const ui = config.ui;
  if (!isPlainObject(ui)) {
    invalid("ui", "expected an object");
  }
  numberIn(ui.pageSize, "ui.pageSize", { min: 1, max: 10000, integer: true });

  return config;
}

/**
 * Load configuration, writing defaults when the file does not exist.
 *
 * The home directory is authoritative from `options.home` / `$DSH_HOME`; a
 * `home` key found in `config.json` is ignored and never persisted. `memoryDir`
 * is the only path override in the file; it stays exactly as configured
 * (`null` means the default). Use {@link resolvePaths} for absolute paths.
 *
 * @param {object} [options]
 * @param {string} [options.home] Explicit plugin home directory.
 * @param {NodeJS.ProcessEnv} [options.env=process.env] Environment to inspect.
 * @returns {Promise<object>} Validated configuration.
 * @throws {HermemoryError} `INVALID_INPUT` for corrupt or invalid JSON.
 */
export async function loadConfig(options = {}) {
  const env = options.env || process.env;
  const home = optionHome(options, env);
  const configFile = path.join(home, "config.json");

  let text;
  try {
    text = await readFile(configFile, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      const defaults = deepClone(DEFAULT_CONFIG);
      validateConfig(defaults);
      await atomicWrite(configFile, `${JSON.stringify(defaults, null, 2)}\n`, 0o600);
      return tagHome(defaults, home);
    }
    throw new HermemoryError(
      "STORE_IO",
      `Failed to read configuration: ${error.message || error}`,
      { status: 500, details: { path: configFile }, cause: error },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new HermemoryError("INVALID_INPUT", "config.json is not valid JSON", {
      status: 400,
      details: { path: "config.json", reason: error.message || "parse error" },
      cause: error,
    });
  }

  if (!isPlainObject(parsed)) {
    invalid("", "config.json must contain a JSON object");
  }

  // `home` is a startup concern, not a persisted one. A hand-edited value must
  // never move the data directory away from the config file that was loaded.
  delete parsed.home;

  const merged = deepMerge(DEFAULT_CONFIG, parsed);
  validateConfig(merged);
  return tagHome(merged, home);
}

/**
 * Deep-merge a patch into the persisted configuration and write it atomically.
 *
 * @param {object} patch Partial configuration.
 * @param {object} [options]
 * @param {string} [options.home] Home directory to write to.
 * @param {NodeJS.ProcessEnv} [options.env=process.env] Environment to inspect.
 * @returns {Promise<object>} The saved, validated configuration.
 * @throws {HermemoryError} `INVALID_INPUT` for a bad patch.
 */
export async function saveConfig(patch, options = {}) {
  if (!isPlainObject(patch)) {
    invalid("", "configuration patch must be a plain object");
  }

  const env = options.env || process.env;
  const requestedHome =
    options.home && options.home.trim() ? path.resolve(options.home.trim()) : null;
  const rememberedHome = lastUsedHome;

  let current;
  let loadedHome = null;
  try {
    current = await loadConfig({
      home: requestedHome || rememberedHome || undefined,
      env,
    });
    loadedHome = getConfigHome(current);
  } catch (error) {
    if (!error || error.code !== "INVALID_INPUT") {
      throw error;
    }
    // Let the settings page repair an invalid config: merge the patch over the
    // raw file when it is still parseable, otherwise over the defaults.
    const fallbackHome = requestedHome || rememberedHome || resolveHome({}, env);
    current = deepClone(DEFAULT_CONFIG);
    try {
      const rawText = await readFile(path.join(fallbackHome, "config.json"), "utf8");
      const raw = JSON.parse(rawText);
      if (isPlainObject(raw)) {
        delete raw.home;
        current = deepMerge(DEFAULT_CONFIG, raw);
      }
    } catch {
      // Corrupt JSON: start from defaults and write a clean file.
    }
  }

  const home = requestedHome || loadedHome || rememberedHome || resolveHome({}, env);
  const merged = deepMerge(current, patch);

  // Keep the data home authoritative: it is selected by the plugin row config
  // or `$DSH_HOME`, and is never persisted into config.json.
  delete merged.home;
  validateConfig(merged);

  const configFile = path.join(home, "config.json");
  await atomicWrite(configFile, `${JSON.stringify(merged, null, 2)}\n`, 0o600);
  return tagHome(merged, home);
}

/**
 * Deep-copy a configuration with secrets removed.
 *
 * The result keeps the same shape and adds boolean `apiKeySet` flags so the
 * settings page can show whether a key is configured without receiving it.
 *
 * @param {object} config Configuration to redact.
 * @returns {object} Redacted copy.
 */
export function redactConfig(config) {
  const copy = deepClone(config);
  if (!isPlainObject(copy.backend)) {
    return copy;
  }
  for (const endpointName of ["embedding", "chat"]) {
    const endpoint = copy.backend[endpointName];
    if (!isPlainObject(endpoint)) {
      continue;
    }
    endpoint.apiKeySet = typeof endpoint.apiKey === "string" && endpoint.apiKey.length > 0;
    delete endpoint.apiKey;
  }
  return copy;
}

/**
 * Load `state.json`, tolerating a missing or corrupt file.
 *
 * @param {object} [options]
 * @param {string} [options.home] Explicit plugin home directory.
 * @param {NodeJS.ProcessEnv} [options.env=process.env] Environment to inspect.
 * @returns {Promise<object>} State merged over {@link DEFAULT_STATE}.
 */
export async function loadState(options = {}) {
  const env = options.env || process.env;
  const home = optionHome(options, env);
  const raw = await readJson(path.join(home, "state.json"), null);
  const base = deepClone(DEFAULT_STATE);
  const state = isPlainObject(raw) ? deepMerge(base, raw) : base;
  return tagHome(state, home);
}

/**
 * Atomically write the state file.
 *
 * @param {object} state State object.
 * @param {object} [options]
 * @param {string} [options.home] Explicit plugin home directory.
 * @param {NodeJS.ProcessEnv} [options.env=process.env] Environment to inspect.
 * @returns {Promise<object>} The saved state merged over defaults.
 */
export async function saveState(state, options = {}) {
  if (!isPlainObject(state)) {
    invalid("state", "state must be a plain object");
  }
  const env = options.env || process.env;
  const home = options.home && options.home.trim()
    ? path.resolve(options.home.trim())
    : getConfigHome(state) || lastUsedHome || resolveHome({}, env);
  const merged = deepMerge(DEFAULT_STATE, state);
  await atomicWrite(path.join(home, "state.json"), `${JSON.stringify(merged, null, 2)}\n`, 0o600);
  return tagHome(merged, home);
}

export { resolveHome, resolvePaths };
