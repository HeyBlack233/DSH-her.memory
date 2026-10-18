/**
 * Content version stamps (`semantic_version.json`).
 *
 * The hash covers only stable content fields, in file order, never embeddings.
 * This matches her.memory: unchanged content keeps the same version even when
 * vectors are recomputed.
 *
 * @module version-stamp
 */

import crypto from "node:crypto";

import { atomicWrite, localIsoNow, readJson } from "./util.js";

/** Hash-relevant fields for one entry. */
function entryKey(entry) {
  const type = typeof entry.type === "string" ? entry.type : "";
  const category = typeof entry.category === "string" ? entry.category : "";
  const date =
    typeof entry.event_date === "string"
      ? entry.event_date
      : typeof entry.date === "string"
        ? entry.date
        : "";
  const text =
    typeof entry.text === "string"
      ? entry.text
      : typeof entry.content === "string"
        ? entry.content
        : "";
  return `${type}\x1f${category}\x1f${date}\x1f${text}`;
}

/**
 * Compute the current content stamp over both store files.
 *
 * @param {import("./store.js").JsonlStore} store Store to inspect.
 * @returns {Promise<{
 *   schema_version: number,
 *   content_sha256: string,
 *   version_short: string,
 *   entries_total: number,
 *   entries_archived: number,
 *   entries_active: number,
 *   built_at: string,
 * }>}
 */
export async function computeStamp(store) {
  const active = await store.loadActive({ includeArchived: true });
  const archived = await store.loadArchive();

  const hash = crypto.createHash("sha256");
  let entriesTotal = 0;
  let entriesArchived = 0;

  const scan = (entries, fromArchiveFile) => {
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      entriesTotal += 1;
      if (fromArchiveFile || entry.archived || entry._archived) {
        entriesArchived += 1;
      }
      hash.update(Buffer.from(`${entryKey(entry)}\n`, "utf8"));
    }
  };

  scan(active, false);
  scan(archived, true);

  const digest = hash.digest("hex");
  return {
    schema_version: 1,
    content_sha256: digest,
    version_short: digest.slice(0, 12),
    entries_total: entriesTotal,
    entries_archived: entriesArchived,
    entries_active: entriesTotal - entriesArchived,
    built_at: localIsoNow().slice(0, 19).replace("T", " "),
  };
}

/**
 * Recompute and atomically write the version stamp.
 *
 * @param {import("./store.js").JsonlStore} store Store to stamp.
 * @returns {Promise<object>} The written stamp.
 */
export async function writeStamp(store) {
  const stamp = await computeStamp(store);
  await atomicWrite(store.paths.versionFile, `${JSON.stringify(stamp, null, 2)}\n`, 0o600);
  return stamp;
}

/**
 * Read the last written version stamp.
 *
 * @param {import("./store.js").JsonlStore} store Store to inspect.
 * @returns {Promise<object|null>} Stamp, or `null` when missing/corrupt.
 */
export async function readStamp(store) {
  const stamp = await readJson(store.paths.versionFile, null);
  return stamp && typeof stamp === "object" && !Array.isArray(stamp) ? stamp : null;
}
