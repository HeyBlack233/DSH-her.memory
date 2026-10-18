/**
 * Shared test helpers: temporary homes, stores, configs, JSONL IO, and a
 * silent logger fixture.
 *
 * @module test/helpers
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG, saveConfig } from "../lib/config.js";
import { createEngine } from "../lib/engine.js";
import { resolvePaths } from "../lib/paths.js";
import { JsonlStore } from "../lib/store.js";
import { deepMerge, localIsoNow, newMemoryId } from "../lib/util.js";

/**
 * Create a temp directory and register its removal on the test context.
 *
 * @param {import("node:test").TestContext} [t] Test context with `after`.
 * @param {string} [prefix] Directory prefix.
 * @returns {Promise<string>} Absolute temp directory.
 */
export async function makeTempDir(t, prefix = "dsh-her-memory-test-") {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  if (t && typeof t.after === "function") {
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
    });
  }
  return dir;
}

/**
 * Build a full configuration with the default sections plus overrides.
 *
 * @param {string} home Home directory used by `resolvePaths`.
 * @param {object} [overrides] Deep-merged configuration overrides.
 * @returns {object}
 */
export function makeConfig(home, overrides = {}) {
  return deepMerge(DEFAULT_CONFIG, { home, ...overrides });
}

/**
 * Create a ready-to-use store in a fresh temp home.
 *
 * @param {import("node:test").TestContext} [t] Test context.
 * @param {object} [overrides] Configuration overrides.
 * @returns {Promise<{dir: string, home: string, config: object, paths: object, store: JsonlStore, cleanup: Function}>}
 */
export async function makeTempStore(t, overrides = {}) {
  const dir = await makeTempDir(t);
  const config = makeConfig(dir, overrides);
  const paths = resolvePaths(config);
  const store = new JsonlStore({ config, paths, logger: silentLogger() });
  await store.ensureDirs();
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true });
  };
  return { dir, home: dir, config, paths, store, cleanup };
}

/**
 * Build a memory entry with sensible defaults.
 *
 * @param {object} [overrides] Field overrides.
 * @returns {object}
 */
export function makeEntry(overrides = {}) {
  const now = localIsoNow();
  return {
    id: newMemoryId(),
    text: "default memory text",
    type: "general",
    category: "general",
    timestamp: now,
    archived: false,
    energy: 2.0,
    last_hit: now,
    ...overrides,
  };
}

/**
 * Write an array of objects as JSONL (with a trailing newline).
 *
 * @param {string} file Destination file.
 * @param {object[]} entries Entries.
 * @returns {Promise<void>}
 */
export async function writeJsonl(file, entries) {
  await mkdir(path.dirname(file), { recursive: true });
  const content = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  await writeFile(file, content, "utf8");
}

/**
 * Write raw text (used to plant corrupt JSONL).
 *
 * @param {string} file Destination file.
 * @param {string} content Raw content.
 * @returns {Promise<void>}
 */
export async function writeRaw(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

/**
 * Read and parse a JSONL file.
 *
 * @param {string} file Source file.
 * @returns {Promise<object[]>}
 */
export async function readJsonl(file) {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Read a file as text.
 *
 * @param {string} file Source file.
 * @returns {Promise<string>}
 */
export async function readText(file) {
  return readFile(file, "utf8");
}

/**
 * Read and parse a JSON file.
 *
 * @param {string} file Source file.
 * @returns {Promise<*>}
 */
export async function readJsonFile(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/**
 * A logger that records warnings instead of printing.
 *
 * @returns {{warnings: *[], warn: Function, error: Function, info: Function}}
 */
export function captureLogger() {
  const warnings = [];
  return {
    warnings,
    warn(...args) {
      warnings.push(args);
    },
    error(...args) {
      warnings.push(args);
    },
    info() {},
  };
}

/**
 * A logger that discards everything.
 *
 * @returns {{warn: Function, error: Function, info: Function}}
 */
export function silentLogger() {
  return { warn() {}, error() {}, info() {} };
}

/**
 * Persist a configuration and create an initialized engine for a temp home.
 *
 * @param {import("node:test").TestContext} [t] Test context.
 * @param {object} [overrides] Configuration overrides persisted to config.json.
 * @param {object} [options]
 * @param {object|null} [options.logger] Logger override.
 * @param {object|null} [options.ctx] DSH context.
 * @param {object[]} [options.skills] Initial skills.
 * @param {object[]} [options.tools] Initial tools.
 * @returns {Promise<{dir: string, home: string, engine: object, config: object, cleanup: Function}>}
 */
export async function makeEngine(t, overrides = {}, options = {}) {
  const dir = await makeTempDir(t);
  if (overrides && Object.keys(overrides).length > 0) {
    await saveConfig(overrides, { home: dir });
  }
  const engine = createEngine({
    ctx: options.ctx ?? null,
    config: { home: dir },
    logger: options.logger ?? silentLogger(),
    skills: options.skills,
    tools: options.tools,
  });
  await engine.ready;
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true });
  };
  return { dir, home: dir, engine, cleanup };
}

/**
 * Backend configuration block pointing at a fake HTTP server.
 *
 * @param {string} baseUrl Server base URL.
 * @param {"ollama"|"llama-cpp"|"openai-compatible"} [kind="ollama"] Wire protocol.
 * @param {object} [overrides] Deep-merged backend overrides.
 * @returns {object}
 */
export function backendConfig(baseUrl, kind = "ollama", overrides = {}) {
  const ollama = kind === "ollama";
  return deepMerge(
    {
      kind,
      embedding: {
        url: ollama ? `${baseUrl}/api/embeddings` : `${baseUrl}/v1/embeddings`,
        model: "test-embed",
        apiKey: "",
        timeoutMs: 2000,
      },
      chat: {
        url: ollama ? `${baseUrl}/api/generate` : `${baseUrl}/v1/chat/completions`,
        model: "test-chat",
        apiKey: "",
        timeoutMs: 2000,
      },
    },
    overrides,
  );
}

/**
 * Sleep helper for lock tests.
 *
 * @param {number} ms Milliseconds.
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
