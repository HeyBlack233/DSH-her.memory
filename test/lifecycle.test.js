import test from "node:test";
import assert from "node:assert/strict";
import { readdir, stat } from "node:fs/promises";

import { HermemoryError } from "../lib/errors.js";
import {
  addMemory,
  archiveMemory,
  backfill,
  deleteMemory,
  maintain,
  normalizeEventDate,
  normalizeProjectKey,
  stableKeyFromText,
  updateMemory,
} from "../lib/lifecycle.js";
import { readStamp } from "../lib/version-stamp.js";
import {
  makeEntry,
  makeTempStore,
  readJsonl,
  writeJsonl,
} from "./helpers.js";

/** Backend that returns a deterministic vector. */
function okBackend() {
  return {
    kind: "ollama",
    embed: async (text) => [text.length, 1],
    chat: async () => "YES",
  };
}

/** Backend whose embedding endpoint always fails. */
function failingBackend() {
  return {
    kind: "ollama",
    embed: async () => {
      throw new HermemoryError("BACKEND_UNAVAILABLE", "embedding service is down", {
        status: 503,
      });
    },
    chat: async () => "YES",
  };
}

test("normalizeProjectKey and stableKeyFromText follow her.memory semantics", () => {
  assert.equal(normalizeProjectKey(" Owner/Repo "), "owner/repo");
  assert.equal(normalizeProjectKey("   "), null);
  assert.equal(normalizeProjectKey(null), null);
  assert.equal(stableKeyFromText("[topic_x] fact"), "[topic_x]");
  assert.equal(stableKeyFromText("[]"), null);
  assert.equal(stableKeyFromText("plain fact"), null);
  assert.equal(stableKeyFromText(`[${"x".repeat(50)}]`), null);
});

test("normalizeEventDate validates and normalizes dates", () => {
  assert.equal(normalizeEventDate("2026-08-14"), "2026-08-14");
  assert.equal(normalizeEventDate("2026-08-14T12:30:00Z"), "2026-08-14");
  assert.equal(normalizeEventDate(null), null);
  assert.equal(normalizeEventDate(undefined), undefined);
  assert.throws(
    () => normalizeEventDate("not a date"),
    (error) => error.code === "INVALID_INPUT" && error.details.path === "eventDate",
  );
});

test("addMemory writes a full entry, a stable key, and a version stamp", async (t) => {
  const { store, config } = await makeTempStore(t);
  const result = await addMemory(store, config, okBackend(), {
    text: "  [topic_x] Owner prefers jasmine tea  ",
    type: "preference",
    category: "user_profile",
    eventDate: "2026-08-14",
    projectKey: " Owner/Repo ",
    origin: { tool: "memory_add" },
  });

  assert.equal(result.added, true);
  assert.equal(result.duplicateId, null);
  assert.equal(result.hasEmbedding, true);
  assert.deepEqual(result.warnings, []);

  const [entry] = await store.loadActive();
  assert.equal(entry.id, result.id);
  assert.equal(entry.text, "[topic_x] Owner prefers jasmine tea");
  assert.equal(entry.type, "preference");
  assert.equal(entry.category, "user_profile");
  assert.equal(entry.stable_key, "[topic_x]");
  assert.equal(entry.event_date, "2026-08-14");
  assert.equal(entry.project_key, "owner/repo");
  assert.deepEqual(entry.origin, { tool: "memory_add" });
  assert.equal(entry.archived, false);
  assert.equal(entry.energy, 2.0);
  assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.deepEqual(entry.embedding, [entry.text.length, 1]);

  const stamp = await readStamp(store);
  assert.equal(stamp.entries_total, 1);
  assert.equal(stamp.entries_active, 1);
  assert.equal(stamp.entries_archived, 0);
});

test("addMemory rejects empty text and invalid types", async (t) => {
  const { store, config } = await makeTempStore(t);
  await assert.rejects(
    () => addMemory(store, config, null, { text: "   " }),
    (error) => error.code === "INVALID_INPUT" && error.details.path === "text",
  );
  await assert.rejects(
    () => addMemory(store, config, null, { text: "fact", type: "opinion" }),
    (error) => error.code === "INVALID_INPUT" && error.details.path === "type",
  );
});

test("addMemory stores the fact without an embedding when the backend fails", async (t) => {
  const { store, config } = await makeTempStore(t);
  const result = await addMemory(store, config, failingBackend(), { text: "no vector" });

  assert.equal(result.added, true);
  assert.equal(result.hasEmbedding, false);
  assert.equal(result.warnings.length, 1);
  const [entry] = await store.loadActive();
  assert.equal(entry.embedding, undefined);
});

test("dedupe gates writes by project key and category case-insensitively", async (t) => {
  const { store, config } = await makeTempStore(t);
  const first = await addMemory(store, config, null, {
    text: "first fact",
    category: "Tech_Lessons",
    projectKey: "Owner/Repo",
  });
  assert.equal(first.added, true);

  const duplicate = await addMemory(store, config, null, {
    text: "second fact",
    category: "tech_lessons",
    projectKey: " owner/repo ",
    dedupe: true,
  });
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.duplicateId, first.id);
  assert.equal((await store.loadActive()).length, 1);

  const noKey = await addMemory(store, config, null, {
    text: "third fact",
    category: "tech_lessons",
    dedupe: true,
  });
  assert.equal(noKey.added, true);
  assert.match(noKey.warnings[0], /dedupe was ignored/);
});

test("updateMemory supersedes the old entry and preserves key fields", async (t) => {
  const { store, config } = await makeTempStore(t);
  const added = await addMemory(store, config, okBackend(), {
    text: "[old_key] first version",
    type: "general",
    category: "user_profile",
    eventDate: "2026-08-14",
    projectKey: "owner/repo",
  });

  const updated = await updateMemory(store, config, okBackend(), {
    id: added.id,
    text: "[new_key] second version",
    type: "preference",
    origin: { tool: "memory_update" },
  });

  assert.equal(updated.updated, true);
  assert.equal(updated.oldId, added.id);
  assert.notEqual(updated.newId, added.id);
  assert.equal(updated.hasEmbedding, true);

  const active = await store.loadActive();
  assert.deepEqual(active.map((entry) => entry.id), [updated.newId]);

  const all = await store.loadActive({ includeArchived: true });
  const oldEntry = all.find((entry) => entry.id === added.id);
  const newEntry = all.find((entry) => entry.id === updated.newId);
  assert.equal(oldEntry.archived, true);
  assert.equal(oldEntry.superseded_by, updated.newId);
  assert.equal(oldEntry.archive_reason, `superseded:${updated.newId}`);
  assert.match(oldEntry.supersede_date, /^\d{4}-\d{2}-\d{2}T/);

  assert.deepEqual(newEntry.supersedes, [added.id]);
  assert.equal(newEntry.stable_key, "[new_key]");
  assert.equal(newEntry.type, "preference");
  assert.equal(newEntry.category, "user_profile");
  assert.equal(newEntry.project_key, "owner/repo");
  assert.equal(newEntry.event_date, "2026-08-14");
  assert.deepEqual(newEntry.origin, { tool: "memory_update" });
  assert.ok(newEntry.energy >= 2.0);
});

test("updateMemory requires a real content field and an existing active id", async (t) => {
  const { store, config } = await makeTempStore(t);
  const added = await addMemory(store, config, null, { text: "a fact" });

  await assert.rejects(
    () => updateMemory(store, config, null, { id: added.id, origin: { tool: "x" } }),
    (error) => error.code === "INVALID_INPUT" && /text, type, category, or eventDate/.test(error.message),
  );
  await assert.rejects(
    () => updateMemory(store, config, null, { id: "missing", text: "new" }),
    (error) => error.code === "NOT_FOUND",
  );
});

test("archiveMemory marks entries once and reports already-archived calls", async (t) => {
  const { store, config } = await makeTempStore(t);
  const added = await addMemory(store, config, null, { text: "to archive" });

  const archived = await archiveMemory(store, config, {
    id: added.id,
    reason: "user asked",
  });
  assert.deepEqual(archived, { archived: true, id: added.id });
  assert.equal((await store.loadActive()).length, 0);

  const [entry] = await store.loadActive({ includeArchived: true });
  assert.equal(entry.archived, true);
  assert.equal(entry.archive_reason, "user asked");
  assert.match(entry.archive_date, /^\d{4}-\d{2}-\d{2}T/);

  const again = await archiveMemory(store, config, { id: added.id });
  assert.deepEqual(again, { archived: false, alreadyArchived: true });

  await assert.rejects(
    () => archiveMemory(store, config, { id: "missing" }),
    (error) => error.code === "NOT_FOUND",
  );
});

test("deleteMemory requires confirmation, snapshots, and removes from both files", async (t) => {
  const { store, config } = await makeTempStore(t);
  const activeOne = await addMemory(store, config, null, { text: "active" });
  const archivedOne = await addMemory(store, config, null, { text: "archived" });
  await archiveMemory(store, config, { id: archivedOne.id });

  await assert.rejects(
    () => deleteMemory(store, config, { id: activeOne.id }),
    (error) => error.code === "INVALID_INPUT" && error.details.path === "confirm",
  );

  const result = await deleteMemory(store, config, {
    id: archivedOne.id,
    confirm: true,
  });
  assert.deepEqual(result, { deleted: true, id: archivedOne.id });

  const allIds = [
    ...(await store.loadActive({ includeArchived: true })),
    ...(await store.loadArchive()),
  ].map((entry) => entry.id);
  assert.ok(!allIds.includes(archivedOne.id));

  const snapshots = await readdir(store.paths.snapshotsDir);
  assert.ok(snapshots.some((name) => name.startsWith("backup_")));

  await assert.rejects(
    () => deleteMemory(store, config, { id: "missing", confirm: true }),
    (error) => error.code === "NOT_FOUND",
  );
});

test("maintain settles hits, decays energy, moves archived entries, and archives stale ones", async (t) => {
  const { store, config } = await makeTempStore(t);
  const now = Date.now();
  await writeJsonl(store.paths.activeFile, [
    makeEntry({ id: "hit", text: "hit", energy: 2 }),
    makeEntry({
      id: "old",
      text: "old",
      energy: 2,
      last_hit: new Date(now - 200 * 86400000).toISOString(),
    }),
    makeEntry({ id: "pending", text: "pending", archived: true }),
  ]);
  await writeJsonl(store.paths.archiveFile, [
    makeEntry({ id: "archived", text: "archived", archived: true }),
  ]);
  store.invalidateCache();
  await store.logHit("hit");

  const result = await maintain(store, config);
  assert.deepEqual(result, {
    active: 1,
    archived: 3,
    boosted: 1,
    decayed: 3,
    moved: 1,
    archivedByAge: 1,
  });

  const active = await store.loadActive({ includeArchived: true });
  assert.deepEqual(active.map((entry) => entry.id), ["hit"]);
  assert.ok(active[0].energy > 2);
  assert.ok(Math.abs(active[0].energy - 2.2 * 0.97) < 1e-9);

  const archived = await store.loadArchive();
  const ids = archived.map((entry) => entry.id).sort();
  assert.deepEqual(ids, ["archived", "old", "pending"]);
  const oldEntry = archived.find((entry) => entry.id === "old");
  assert.equal(oldEntry.archived, true);
  assert.match(oldEntry.archive_reason, /inactive for 200 days/);

  assert.equal((await stat(store.hitFile)).size, 0);

  const stamp = await readStamp(store);
  assert.equal(stamp.entries_total, 4);
  assert.equal(stamp.entries_archived, 3);
  assert.equal(stamp.entries_active, 1);
});

test("maintain keeps hits when the write fails", async (t) => {
  const { store, config } = await makeTempStore(t);
  await addMemory(store, config, null, { text: "hit me" });
  const [entry] = await store.loadActive();
  await store.logHit(entry.id);

  const originalWrite = store.writeActive.bind(store);
  store.writeActive = async () => {
    throw new HermemoryError("STORE_IO", "simulated write failure", { status: 500 });
  };
  t.after(() => {
    store.writeActive = originalWrite;
  });

  await assert.rejects(() => maintain(store, config), /simulated write failure/);
  assert.ok((await stat(store.hitFile)).size > 0);
});

test("backfill fills only missing embeddings and snapshots first", async (t) => {
  const { store, config } = await makeTempStore(t);
  await writeJsonl(store.paths.activeFile, [
    makeEntry({ id: "a", text: "alpha" }),
    makeEntry({ id: "b", text: "beta", embedding: [1] }),
    makeEntry({ id: "c", text: "" }),
  ]);
  store.invalidateCache();

  const result = await backfill(store, config, okBackend());
  assert.equal(result.total, 3);
  assert.equal(result.filled, 1);
  assert.equal(result.skipped, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.warnings, []);

  const entries = await store.loadActive();
  assert.deepEqual(entries.find((entry) => entry.id === "a").embedding, [5, 1]);
  assert.deepEqual(entries.find((entry) => entry.id === "b").embedding, [1]);

  const snapshots = await readdir(store.paths.snapshotsDir);
  assert.ok(snapshots.some((name) => name.startsWith("backup_")));
});

test("backfill --all reports per-entry failures and keeps old vectors", async (t) => {
  const { store, config } = await makeTempStore(t);
  await writeJsonl(store.paths.activeFile, [
    makeEntry({ id: "a", text: "alpha" }),
    makeEntry({ id: "b", text: "beta", embedding: [1] }),
    makeEntry({ id: "c", text: "" }),
  ]);
  store.invalidateCache();

  const result = await backfill(store, config, failingBackend(), { all: true });
  assert.equal(result.total, 3);
  assert.equal(result.filled, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.warnings.length, 2);

  const entries = await store.loadActive();
  assert.deepEqual(entries.find((entry) => entry.id === "b").embedding, [1]);
});

test("backfill requires an enabled backend", async (t) => {
  const { store, config } = await makeTempStore(t);
  await assert.rejects(
    () => backfill(store, config, { kind: "none" }),
    (error) => error.code === "BACKEND_UNAVAILABLE",
  );
});
