/**
 * Human-readable JSONL store with cross-process locking, atomic rewrites,
 * snapshots, retrieval-hit logging, and cached parsing.
 *
 * The lock file lives next to the active store (`semantic_memories.jsonl.lock`).
 * All mutating operations take the lock; `writeActive`/`writeArchive` assume the
 * caller already holds it (use {@link JsonlStore#transaction} normally).
 *
 * @module store
 */

import crypto from "node:crypto";
import path from "node:path";
import {
  appendFile,
  copyFile,
  mkdir,
  open,
  readFile,
  stat,
  truncate,
  unlink,
} from "node:fs/promises";

import { HermemoryError } from "./errors.js";
import { ensureDirs as ensurePathDirs } from "./paths.js";
import {
  atomicWrite,
  compactLocalTimestamp,
  deepClone,
  isPlainObject,
  localIsoNow,
  safeJsonParse,
  sleep,
} from "./util.js";

/**
 * JSONL store bound to one memory directory.
 */
export class JsonlStore {
  /**
   * @param {object} options
   * @param {object} options.config Loaded configuration (used for limits).
   * @param {ReturnType<import("./paths.js").resolvePaths>} options.paths Resolved paths.
   * @param {object|null} [options.logger] Optional `{ warn, error, info }` logger.
   */
  constructor({ config = {}, paths, logger = null } = {}) {
    if (!paths || !paths.activeFile || !paths.archiveFile) {
      throw new HermemoryError("INVALID_INPUT", "JsonlStore requires resolved paths", {
        details: { path: "paths" },
      });
    }

    /** @type {object} */
    this.config = config;
    /** @type {ReturnType<import("./paths.js").resolvePaths>} */
    this.paths = paths;
    /** @type {string} */
    this.memoryDir = paths.memoryDir;
    /** @type {string} */
    this.activeFile = paths.activeFile;
    /** @type {string} */
    this.archiveFile = paths.archiveFile;
    /** @type {string} */
    this.hitFile = paths.hitFile;
    /** @type {string} */
    this.lockFile = `${paths.activeFile}.lock`;
    /** @type {object|null} */
    this.logger = logger;

    /** @type {Map<string, {mtimeMs: number, size: number, ino: number, entries: object[], corrupt: number}>} */
    this._cache = new Map();
    /** @type {Map<string, number>} */
    this._corruptCounts = new Map();
    /** @type {Promise<void>} */
    this._localChain = Promise.resolve();
    /** @type {Promise<*>} */
    this._hitQueue = Promise.resolve();
  }

  /** Best-effort warning that never masks the primary operation. */
  _warn(message, error) {
    try {
      if (this.logger && typeof this.logger.warn === "function") {
        this.logger.warn(message, error);
      }
    } catch {
      // Logging must never break the store.
    }
  }

  /**
   * Create the memory, snapshot, and proposal directories.
   *
   * @returns {Promise<JsonlStore>} This store.
   */
  async ensureDirs() {
    await ensurePathDirs(this.paths);
    return this;
  }

  /**
   * Acquire the in-process mutex, then the cross-process lock, and run `fn`.
   *
   * @template T
   * @param {() => Promise<T>|T} fn Critical section.
   * @param {object} [options]
   * @param {number} [options.timeoutMs=5000] Lock acquisition timeout.
   * @param {number} [options.staleMs=120000] Age after which a lock is stale.
   * @returns {Promise<T>}
   * @throws {HermemoryError} `STORE_LOCKED` on timeout, `STORE_IO` on lock IO failure.
   */
  async withLock(fn, { timeoutMs = 5000, staleMs = 120000 } = {}) {
    if (typeof fn !== "function") {
      throw new HermemoryError("INVALID_INPUT", "withLock requires a function", {
        details: { path: "fn" },
      });
    }

    const releaseLocal = await this._acquireLocalMutex();
    let token = null;
    try {
      token = await this._acquireFileLock({ timeoutMs, staleMs });
      return await fn();
    } finally {
      if (token) {
        await this._releaseFileLock(token);
      }
      releaseLocal();
    }
  }

  /** Queue behind earlier in-process critical sections. */
  async _acquireLocalMutex() {
    const previous = this._localChain;
    let release;
    this._localChain = new Promise((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    return () => {
      release();
    };
  }

  /** @returns {Promise<string>} Lock token. */
  async _acquireFileLock({ timeoutMs = 5000, staleMs = 120000 } = {}) {
    const token = `${process.pid}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
    const startedAt = new Date().toISOString();
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);

    await mkdir(path.dirname(this.lockFile), { recursive: true });

    for (;;) {
      let handle;
      try {
        handle = await open(this.lockFile, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, startedAt }), "utf8");
        await handle.close();
        return token;
      } catch (error) {
        const createdLock = Boolean(handle);
        if (handle) {
          await handle.close().catch(() => {});
        }
        if (!error || error.code !== "EEXIST") {
          if (createdLock) {
            await unlink(this.lockFile).catch(() => {});
          }
          throw new HermemoryError("STORE_IO", `Failed to acquire store lock: ${error?.message || error}`, {
            status: 500,
            details: { path: this.lockFile },
            cause: error,
          });
        }
      }

      const lockInfo = await this._inspectLock({ staleMs });
      if (lockInfo.missing) {
        continue;
      }
      if (lockInfo.stale || lockInfo.dead) {
        try {
          await unlink(this.lockFile);
        } catch (error) {
          if (!error || error.code !== "ENOENT") {
            throw new HermemoryError(
              "STORE_IO",
              `Failed to remove stale store lock: ${error?.message || error}`,
              {
                status: 500,
                details: { path: this.lockFile },
                cause: error,
              },
            );
          }
        }
        continue;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new HermemoryError("STORE_LOCKED", "Timed out waiting for the memory store lock", {
          status: 409,
          details: { path: this.lockFile, timeoutMs, staleMs },
        });
      }
      const backoff = Math.min(remaining, 50 + Math.floor(Math.random() * 451));
      await sleep(backoff);
    }
  }

  /** Read the current lock and decide whether it can be broken. */
  async _inspectLock({ staleMs = 120000 } = {}) {
    let raw;
    try {
      raw = await readFile(this.lockFile, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { missing: true };
      }
      throw new HermemoryError("STORE_IO", `Failed to inspect store lock: ${error.message || error}`, {
        status: 500,
        details: { path: this.lockFile },
        cause: error,
      });
    }

    const info = safeJsonParse(raw, null);
    let ageMs = 0;
    try {
      const stats = await stat(this.lockFile);
      ageMs = Date.now() - stats.mtimeMs;
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { missing: true };
      }
    }

    if (isPlainObject(info) && typeof info.startedAt === "string") {
      const started = new Date(info.startedAt);
      if (!Number.isNaN(started.getTime())) {
        ageMs = Date.now() - started.getTime();
      }
    }

    let dead = false;
    const pid = isPlainObject(info) ? Number(info.pid) : NaN;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error && error.code === "ESRCH") {
          dead = true;
        }
      }
    }

    return {
      missing: false,
      stale: ageMs > staleMs,
      dead,
      token: isPlainObject(info) && typeof info.token === "string" ? info.token : null,
    };
  }

  /** Remove the lock only when this caller still owns it. */
  async _releaseFileLock(token) {
    let raw;
    try {
      raw = await readFile(this.lockFile, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return;
      }
      this._warn(`Failed to read lock during release ${this.lockFile}`, error);
      return;
    }

    const info = safeJsonParse(raw, null);
    if (!isPlainObject(info) || info.token !== token) {
      return;
    }

    await unlink(this.lockFile).catch((error) => {
      if (error && error.code !== "ENOENT") {
        this._warn(`Failed to release lock ${this.lockFile}`, error);
      }
    });
  }

  /** Parse a JSONL file, caching by mtime and size. */
  async _readJsonl(file) {
    let fileStat;
    try {
      fileStat = await stat(file);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { mtimeMs: 0, size: 0, ino: 0, entries: [], corrupt: 0 };
      }
      throw new HermemoryError("STORE_IO", `Failed to stat ${file}: ${error.message || error}`, {
        status: 500,
        details: { path: file },
        cause: error,
      });
    }

    const cached = this._cache.get(file);
    if (
      cached &&
      cached.mtimeMs === fileStat.mtimeMs &&
      cached.size === fileStat.size &&
      cached.ino === fileStat.ino
    ) {
      return cached;
    }

    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { mtimeMs: 0, size: 0, ino: 0, entries: [], corrupt: 0 };
      }
      throw new HermemoryError("STORE_IO", `Failed to read ${file}: ${error.message || error}`, {
        status: 500,
        details: { path: file },
        cause: error,
      });
    }

    const entries = [];
    const corruptLines = [];
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        corruptLines.push({
          lineno: index + 1,
          error: error.message || "invalid JSON",
          fragment: trimmed.slice(0, 100),
        });
        return;
      }
      if (!isPlainObject(parsed)) {
        corruptLines.push({
          lineno: index + 1,
          error: "entry is not a JSON object",
          fragment: trimmed.slice(0, 100),
        });
        return;
      }
      entries.push(parsed);
    });

    if (corruptLines.length > 0) {
      await this._appendCorruptBackup(file, corruptLines);
    }

    const record = {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      ino: fileStat.ino,
      entries,
      corrupt: corruptLines.length,
    };
    this._cache.set(file, record);
    this._corruptCounts.set(file, corruptLines.length);
    return record;
  }

  /** Append skipped corrupt lines to `<file>.corrupt.bak`. */
  async _appendCorruptBackup(file, corruptLines) {
    const backup = `${file}.corrupt.bak`;
    const payload = corruptLines
      .map((line) => `${JSON.stringify(line)}\n`)
      .join("");
    try {
      await appendFile(backup, payload, "utf8");
    } catch (error) {
      this._warn(`Failed to record corrupt lines for ${file}`, error);
    }
  }

  /** Store parsed entries in the cache after a rewrite. */
  async _setCache(file, entries) {
    try {
      const fileStat = await stat(file);
      this._cache.set(file, {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        ino: fileStat.ino,
        entries: deepClone(entries),
        corrupt: 0,
      });
      this._corruptCounts.set(file, 0);
    } catch {
      this._cache.delete(file);
    }
  }

  /**
   * Drop the parse cache for one file (or all files).
   *
   * @param {string} [file] File to invalidate; omit to clear everything.
   */
  invalidateCache(file) {
    if (file) {
      this._cache.delete(file);
      this._corruptCounts.delete(file);
    } else {
      this._cache.clear();
      this._corruptCounts.clear();
    }
  }

  /**
   * Load the active store file.
   *
   * @param {object} [options]
   * @param {boolean} [options.includeArchived=false] Include entries marked archived.
   * @returns {Promise<object[]>} Raw entries (unknown fields preserved).
   */
  async loadActive({ includeArchived = false } = {}) {
    const { entries } = await this._readJsonl(this.activeFile);
    const filtered = includeArchived
      ? entries
      : entries.filter((entry) => entry.archived !== true);
    return deepClone(filtered);
  }

  /**
   * Load the archive file. Archived entries are never filtered by the
   * `archived` flag, because everything in that file is archived by definition.
   *
   * @returns {Promise<object[]>}
   */
  async loadArchive() {
    const { entries } = await this._readJsonl(this.archiveFile);
    return deepClone(entries);
  }

  /**
   * Serialize entries as JSONL with a trailing newline.
   *
   * @param {object[]} entries Entries to serialize.
   * @returns {string}
   */
  _toJsonl(entries) {
    if (!Array.isArray(entries)) {
      throw new HermemoryError("INVALID_INPUT", "entries must be an array", {
        details: { path: "entries" },
      });
    }
    let output = "";
    for (const entry of entries) {
      if (!isPlainObject(entry)) {
        throw new HermemoryError("INVALID_INPUT", "memory entries must be objects", {
          details: { path: "entries" },
        });
      }
      try {
        output += `${JSON.stringify(entry)}\n`;
      } catch (error) {
        throw new HermemoryError("STORE_IO", `Failed to serialize entry: ${error.message || error}`, {
          status: 500,
          cause: error,
        });
      }
    }
    return output;
  }

  /**
   * Atomically rewrite the active store file. Callers must hold the lock.
   *
   * @param {object[]} entries Entries to write.
   * @returns {Promise<void>}
   */
  async writeActive(entries) {
    const content = this._toJsonl(entries);
    await atomicWrite(this.activeFile, content, 0o600);
    await this._setCache(this.activeFile, entries);
  }

  /**
   * Atomically rewrite the archive file. Callers must hold the lock.
   *
   * @param {object[]} entries Entries to write.
   * @returns {Promise<void>}
   */
  async writeArchive(entries) {
    const content = this._toJsonl(entries);
    await atomicWrite(this.archiveFile, content, 0o600);
    await this._setCache(this.archiveFile, entries);
  }

  /**
   * Run a read-modify-write transaction under the store lock.
   *
   * @template T
   * @param {(tx: object) => Promise<T>|T} fn Transaction body.
   * @returns {Promise<T>}
   */
  async transaction(fn) {
    if (typeof fn !== "function") {
      throw new HermemoryError("INVALID_INPUT", "transaction requires a function", {
        details: { path: "fn" },
      });
    }
    return this.withLock(async () => {
      const tx = {
        store: this,
        config: this.config,
        paths: this.paths,
        memoryDir: this.memoryDir,
        activeFile: this.activeFile,
        archiveFile: this.archiveFile,
        loadActive: (options) => this.loadActive(options),
        loadArchive: () => this.loadArchive(),
        writeActive: (entries) => this.writeActive(entries),
        writeArchive: (entries) => this.writeArchive(entries),
        invalidateCache: (file) => this.invalidateCache(file),
      };
      return fn(tx);
    });
  }

  /**
   * Append one entry to the active file (read + rewrite under the lock).
   *
   * @param {object} entry Entry to append.
   * @returns {Promise<object>} The appended entry.
   */
  async appendActive(entry) {
    if (!isPlainObject(entry)) {
      throw new HermemoryError("INVALID_INPUT", "entry must be an object", {
        details: { path: "entry" },
      });
    }
    await this.transaction(async (tx) => {
      const entries = await tx.loadActive({ includeArchived: true });
      entries.push(deepClone(entry));
      await tx.writeActive(entries);
    });
    return entry;
  }

  /**
   * Copy the active and archive files plus a manifest into `_snapshots`.
   *
   * @param {string|null} [label=null] Human-readable reason stored in the manifest.
   * @returns {Promise<object>} Snapshot paths and counts.
   */
  async snapshot(label = null) {
    return this.withLock(async () => {
      await this.ensureDirs();
      const stamp = `${compactLocalTimestamp()}_${crypto.randomBytes(2).toString("hex")}`;
      const files = [];
      let activeSnapshot = null;
      let archiveSnapshot = null;

      const activeTarget = path.join(this.paths.snapshotsDir, `semantic_memories_${stamp}.jsonl`);
      try {
        await copyFile(this.activeFile, activeTarget);
        activeSnapshot = activeTarget;
        files.push(activeTarget);
      } catch (error) {
        if (!error || error.code !== "ENOENT") {
          throw new HermemoryError("STORE_IO", `Failed to snapshot active memories: ${error.message || error}`, {
            status: 500,
            details: { path: this.activeFile },
            cause: error,
          });
        }
      }

      const archiveTarget = path.join(this.paths.snapshotsDir, `archived_memories_${stamp}.jsonl`);
      try {
        await copyFile(this.archiveFile, archiveTarget);
        archiveSnapshot = archiveTarget;
        files.push(archiveTarget);
      } catch (error) {
        if (!error || error.code !== "ENOENT") {
          throw new HermemoryError("STORE_IO", `Failed to snapshot archived memories: ${error.message || error}`, {
            status: 500,
            details: { path: this.archiveFile },
            cause: error,
          });
        }
      }

      const activeEntries = await this._readJsonl(this.activeFile);
      const archiveEntries = await this._readJsonl(this.archiveFile);
      const activeCount = activeEntries.entries.filter((entry) => entry.archived !== true).length;
      const pendingCount = activeEntries.entries.length - activeCount;
      const archivedCount = archiveEntries.entries.length + pendingCount;

      const backupPath = path.join(this.paths.snapshotsDir, `backup_${stamp}.json`);
      const manifest = {
        timestamp: stamp,
        created_at: localIsoNow(),
        active_count: activeCount,
        archived_count: archivedCount,
        files,
        label,
      };
      await atomicWrite(backupPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);

      return {
        timestamp: stamp,
        backupPath,
        files,
        activeSnapshot,
        archiveSnapshot,
        active_count: activeCount,
        archived_count: archivedCount,
      };
    });
  }

  /**
   * Append one retrieval-hit record. Best-effort: the returned promise resolves
   * even when the write fails.
   *
   * @param {string} id Memory id that was returned by search.
   * @returns {Promise<boolean>} `true` when the line was written.
   */
  logHit(id) {
    const memoryId = typeof id === "string" ? id : String(id ?? "");
    if (!memoryId) {
      return Promise.resolve(false);
    }
    const line = `${JSON.stringify({ id: memoryId, ts: localIsoNow() })}\n`;
    this._hitQueue = this._hitQueue.then(async () => {
      try {
        await appendFile(this.hitFile, line, "utf8");
        return true;
      } catch (error) {
        this._warn("Failed to append a retrieval hit", error);
        return false;
      }
    });
    return this._hitQueue;
  }

  /**
   * Append several retrieval-hit records in order.
   *
   * @param {string[]} ids Memory ids.
   * @returns {Promise<boolean[]>}
   */
  logHits(ids) {
    if (!Array.isArray(ids)) {
      return Promise.resolve([]);
    }
    return Promise.all(ids.map((id) => this.logHit(id)));
  }

  /**
   * Read the hit log, optionally truncating it.
   *
   * @param {object} [options]
   * @param {boolean} [options.keep=false] Keep the log for a later explicit clear.
   * @returns {Promise<string[]>} Unique ids in file order.
   */
  async drainHits({ keep = false } = {}) {
    await this._hitQueue.catch(() => {});

    let text;
    try {
      text = await readFile(this.hitFile, "utf8");
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        this._warn("Failed to read retrieval hits", error);
      }
      return [];
    }

    const ids = [];
    const seen = new Set();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const parsed = safeJsonParse(trimmed, null);
      if (!isPlainObject(parsed) || typeof parsed.id !== "string" || !parsed.id) {
        continue;
      }
      if (!seen.has(parsed.id)) {
        seen.add(parsed.id);
        ids.push(parsed.id);
      }
    }

    if (!keep) {
      await this.clearHits();
    }
    return ids;
  }

  /**
   * Truncate the hit log. Uses truncate rather than unlink so another process
   * holding a handle cannot resurrect stale hits.
   *
   * @returns {Promise<void>}
   */
  async clearHits() {
    await this._hitQueue.catch(() => {});
    try {
      await truncate(this.hitFile, 0);
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        this._warn("Failed to clear retrieval hits", error);
      }
    }
  }

  /**
   * Compute overview statistics.
   *
   * @returns {Promise<{
   *   active: number,
   *   archived: number,
   *   pendingCompaction: number,
   *   total: number,
   *   fileSizeBytes: number,
   *   corruptLines: number,
   *   categories: {name: string, count: number}[],
   *   types: {name: string, count: number}[],
   * }>}
   */
  async stats() {
    const activeRaw = await this._readJsonl(this.activeFile);
    const archiveRaw = await this._readJsonl(this.archiveFile);

    const activeEntries = activeRaw.entries.filter((entry) => entry.archived !== true);
    const pendingEntries = activeRaw.entries.filter((entry) => entry.archived === true);
    const archived = archiveRaw.entries.length + pendingEntries.length;
    const total = activeEntries.length + archived;

    let fileSizeBytes = 0;
    try {
      fileSizeBytes = (await stat(this.activeFile)).size;
    } catch {
      fileSizeBytes = 0;
    }

    const categories = new Map();
    const types = new Map();
    for (const entry of activeEntries) {
      const category = typeof entry.category === "string" && entry.category
        ? entry.category
        : "uncategorized";
      const type = typeof entry.type === "string" && entry.type ? entry.type : "general";
      categories.set(category, (categories.get(category) || 0) + 1);
      types.set(type, (types.get(type) || 0) + 1);
    }

    const toSorted = (map) =>
      [...map.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

    return {
      active: activeEntries.length,
      archived,
      pendingCompaction: pendingEntries.length,
      total,
      fileSizeBytes,
      corruptLines:
        (this._corruptCounts.get(this.activeFile) || 0) +
        (this._corruptCounts.get(this.archiveFile) || 0),
      categories: toSorted(categories),
      types: toSorted(types),
    };
  }
}
