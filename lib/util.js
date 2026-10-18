/**
 * Small dependency-free helpers shared by the host core.
 *
 * This module deliberately imports neither the store nor the configuration
 * module so it can be used from every layer without cycles.
 *
 * @module util
 */

import crypto from "node:crypto";
import path from "node:path";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";

/** Two-digit zero padding. */
function pad2(value) {
  return String(value).padStart(2, "0");
}

/**
 * Current local time in her.memory's offset-less ISO format.
 *
 * The Python implementation writes `datetime.now().isoformat()`, which has no
 * timezone suffix. Keeping the same shape makes exported JSONL portable.
 *
 * @returns {string} `YYYY-MM-DDTHH:mm:ss.SSS` in local time.
 */
export function localIsoNow() {
  const now = new Date();
  return (
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
    `T${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}.` +
    String(now.getMilliseconds()).padStart(3, "0")
  );
}

/**
 * Compact local timestamp used in file names, e.g. `20261018_213818`.
 *
 * @param {Date} [date] Date to format; defaults to now.
 * @returns {string}
 */
export function compactLocalTimestamp(date = new Date()) {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_` +
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  );
}

/**
 * Parse a date-ish value without throwing.
 *
 * Strings without an offset (the format written by this plugin) are parsed as
 * local time, matching her.memory.
 *
 * @param {*} value Date, Date-parseable string, or epoch milliseconds.
 * @returns {Date|null} Valid Date or `null`.
 */
export function parseDate(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Generate a memory id in her.memory-compatible form.
 *
 * @returns {string} `mem_<epoch milliseconds>_<6 hex characters>`.
 */
export function newMemoryId() {
  return `mem_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * Cosine similarity between two numeric vectors.
 *
 * Returns 0 for empty, non-array, mismatched-length, or zero-length inputs
 * rather than NaN/Infinity, because callers use this on untrusted JSONL data.
 *
 * @param {number[]} a First vector.
 * @param {number[]} b Second vector.
 * @returns {number} Similarity in `[-1, 1]`, or 0 when undefined.
 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      return 0;
    }
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}

/**
 * Clamp a number into an inclusive range.
 *
 * @param {number} value Input value.
 * @param {number} min Lower bound.
 * @param {number} max Upper bound.
 * @returns {number}
 */
export function clamp(value, min, max) {
  const numeric = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, numeric));
}

/**
 * Test whether a value is a plain object (not an array, Date, or class instance).
 *
 * @param {*} value Candidate value.
 * @returns {boolean}
 */
export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deep-clone JSON-like data (objects and arrays).
 *
 * @param {*} value Value to clone.
 * @returns {*} Clone.
 */
export function deepClone(value) {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item));
  }
  if (isPlainObject(value)) {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = deepClone(item);
    }
    return output;
  }
  return value;
}

/**
 * Deep-merge a patch over a base object without mutating either input.
 *
 * Plain objects merge recursively; arrays and scalar values replace the base.
 * Keys whose patch value is `undefined` are ignored, which lets callers pass
 * sparse option objects.
 *
 * @param {object} base Base object.
 * @param {object} patch Patch object.
 * @returns {object} New merged object.
 */
export function deepMerge(base, patch) {
  const safeBase = isPlainObject(base) ? base : {};
  if (!isPlainObject(patch)) {
    return deepClone(safeBase);
  }
  const output = deepClone(safeBase);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = deepClone(value);
    }
  }
  return output;
}

/**
 * Write a file atomically through a same-directory temporary file and rename.
 *
 * @param {string} file Destination path.
 * @param {string|Uint8Array} content Bytes or text to write.
 * @param {number} [mode=0o600] Unix mode for the new file.
 * @returns {Promise<void>}
 */
export async function atomicWrite(file, content, mode = 0o600) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });

  const tempFile = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`,
  );

  let handle;
  try {
    handle = await open(tempFile, "w", mode);
    await handle.writeFile(content, typeof content === "string" ? "utf8" : undefined);
    await handle.sync();
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      handle = undefined;
    }
    await unlink(tempFile).catch(() => {});
    throw error;
  }

  try {
    await handle.close();
    await rename(tempFile, file);
  } catch (error) {
    await unlink(tempFile).catch(() => {});
    throw error;
  }
}

/**
 * Read and parse a JSON file, returning a fallback on missing/corrupt data.
 *
 * @param {string} file File path.
 * @param {*} [fallback=null] Value returned when reading or parsing fails.
 * @returns {Promise<*>}
 */
export async function readJson(file, fallback = null) {
  try {
    const text = await readFile(file, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Parse JSON text without throwing.
 *
 * @param {string} text JSON text.
 * @param {*} [fallback=null] Value returned on parse failure.
 * @returns {*}
 */
export function safeJsonParse(text, fallback = null) {
  if (typeof text !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Promise-based sleep.
 *
 * @param {number} ms Milliseconds.
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}
