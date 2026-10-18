/**
 * Filesystem layout for the her.memory plugin.
 *
 * The plugin owns one home directory (`$DSH_HOME/her-memory` by default) and
 * never writes inside its package directory. All other modules derive their
 * paths from {@link resolvePaths} instead of hard-coding file names.
 *
 * @module paths
 */

import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";

/**
 * Shared symbol used by `config.js` to remember the home a loaded object came
 * from. It is registered globally so `paths.js` can read it without importing
 * the configuration module (which would create a cycle).
 */
export const HOME_TAG = Symbol.for("@local/dsh-her-memory.home");

/**
 * Resolve the plugin home directory.
 *
 * Precedence: an explicit `config.home`, the home a loaded config/state object
 * was read from, then `$DSH_HOME/her-memory`, then `~/.dsh/her-memory`.
 *
 * @param {object} [config] Configuration object that may contain `home`.
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment to inspect.
 * @returns {string} Absolute home directory.
 */
export function resolveHome(config = {}, env = process.env) {
  if (config && typeof config.home === "string" && config.home.trim()) {
    return path.resolve(config.home.trim());
  }

  if (config && typeof config === "object" && typeof config[HOME_TAG] === "string") {
    return path.resolve(config[HOME_TAG]);
  }

  const dshHome = env && typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  if (dshHome) {
    return path.join(path.resolve(dshHome), "her-memory");
  }

  return path.join(os.homedir(), ".dsh", "her-memory");
}

/**
 * Resolve every file and directory used by the store.
 *
 * A relative `config.memoryDir` is resolved against the home directory. A
 * `null`/missing `memoryDir` means `<home>/memories`, matching her.memory's
 * single-directory layout.
 *
 * @param {object} [config] Configuration object.
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment to inspect.
 * @returns {{
 *   home: string,
 *   configFile: string,
 *   stateFile: string,
 *   memoryDir: string,
 *   activeFile: string,
 *   archiveFile: string,
 *   hitFile: string,
 *   versionFile: string,
 *   snapshotsDir: string,
 *   proposalsDir: string,
 * }}
 */
export function resolvePaths(config = {}, env = process.env) {
  const home = resolveHome(config, env);
  const rawMemoryDir =
    config && typeof config.memoryDir === "string" && config.memoryDir.trim()
      ? config.memoryDir.trim()
      : null;
  const memoryDir = rawMemoryDir
    ? path.isAbsolute(rawMemoryDir)
      ? path.resolve(rawMemoryDir)
      : path.resolve(home, rawMemoryDir)
    : path.join(home, "memories");

  return {
    home,
    configFile: path.join(home, "config.json"),
    stateFile: path.join(home, "state.json"),
    memoryDir,
    activeFile: path.join(memoryDir, "semantic_memories.jsonl"),
    archiveFile: path.join(memoryDir, "archived_memories.jsonl"),
    hitFile: path.join(memoryDir, "retrieval_hits.jsonl"),
    versionFile: path.join(memoryDir, "semantic_version.json"),
    snapshotsDir: path.join(memoryDir, "_snapshots"),
    proposalsDir: path.join(memoryDir, "_proposals"),
  };
}

/**
 * Create the home, memory, snapshots, and proposals directories.
 *
 * @param {ReturnType<typeof resolvePaths>} paths Resolved paths.
 * @returns {Promise<ReturnType<typeof resolvePaths>>} The same paths, after creation.
 */
export async function ensureDirs(paths) {
  await mkdir(paths.home, { recursive: true });
  await mkdir(paths.memoryDir, { recursive: true });
  await mkdir(paths.snapshotsDir, { recursive: true });
  await mkdir(paths.proposalsDir, { recursive: true });
  return paths;
}
