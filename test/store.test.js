import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";

import { HermemoryError } from "../lib/errors.js";
import { makeEntry, makeTempStore, readJsonl, writeJsonl, writeRaw } from "./helpers.js";

test("appendActive/loadActive preserve unknown fields", async (t) => {
  const { store } = await makeTempStore(t);
  const entry = makeEntry({ custom: { nested: true }, extra_field: "kept" });
  await store.appendActive(entry);

  const active = await store.loadActive();
  assert.equal(active.length, 1);
  assert.deepEqual(active[0], entry);

  const raw = await readJsonl(store.paths.activeFile);
  assert.deepEqual(raw[0], entry);
});

test("loadActive filters archived entries and loadArchive never filters", async (t) => {
  const { store } = await makeTempStore(t);
  const active = makeEntry({ text: "active" });
  const pending = makeEntry({ text: "pending", archived: true });
  const archived = makeEntry({ text: "archived", archived: true });
  await writeJsonl(store.paths.activeFile, [active, pending]);
  await writeJsonl(store.paths.archiveFile, [archived]);

  const defaultActive = await store.loadActive();
  assert.deepEqual(defaultActive.map((entry) => entry.text), ["active"]);
  assert.equal((await store.loadActive({ includeArchived: true })).length, 2);
  assert.deepEqual((await store.loadArchive()).map((entry) => entry.text), ["archived"]);
});

test("corrupt lines are skipped, recorded, and cached", async (t) => {
  const { store } = await makeTempStore(t);
  const valid = makeEntry({ text: "valid" });
  await writeRaw(
    store.paths.activeFile,
    `${JSON.stringify(valid)}\n{not-json\n\n"just a string"\n`,
  );

  const active = await store.loadActive();
  assert.equal(active.length, 1);

  const backupPath = `${store.paths.activeFile}.corrupt.bak`;
  const backupLines = (await readFile(backupPath, "utf8")).trim().split("\n");
  assert.equal(backupLines.length, 2);
  const first = JSON.parse(backupLines[0]);
  assert.equal(first.lineno, 2);
  assert.equal(typeof first.error, "string");
  assert.equal(first.fragment, "{not-json");

  // Cache hit: corrupt lines must not be appended a second time.
  await store.loadActive();
  const again = (await readFile(backupPath, "utf8")).trim().split("\n");
  assert.equal(again.length, 2);

  const stats = await store.stats();
  assert.equal(stats.corruptLines, 2);
});

test("writes invalidate and refresh the parse cache", async (t) => {
  const { store } = await makeTempStore(t);
  await store.appendActive(makeEntry({ text: "first" }));
  assert.equal((await store.loadActive()).length, 1);

  await store.appendActive(makeEntry({ text: "second" }));
  assert.equal((await store.loadActive()).length, 2);

  await store.writeActive([makeEntry({ text: "rewritten" })]);
  assert.deepEqual((await store.loadActive()).map((entry) => entry.text), ["rewritten"]);
});

test("withLock times out while a live lock exists", async (t) => {
  const { store } = await makeTempStore(t);
  await writeFile(
    store.lockFile,
    JSON.stringify({
      pid: process.pid,
      token: "someone-else",
      startedAt: new Date().toISOString(),
    }),
  );

  await assert.rejects(
    () => store.withLock(async () => "never", { timeoutMs: 120, staleMs: 60000 }),
    (error) => {
      assert.ok(error instanceof HermemoryError);
      assert.equal(error.code, "STORE_LOCKED");
      assert.equal(error.status, 409);
      return true;
    },
  );

  await rm(store.lockFile, { force: true });
});

test("withLock takes over a stale lock", async (t) => {
  const { store } = await makeTempStore(t);
  await writeFile(
    store.lockFile,
    JSON.stringify({
      pid: process.pid,
      token: "stale",
      startedAt: new Date(Date.now() - 600000).toISOString(),
    }),
  );

  const value = await store.withLock(async () => 42, { timeoutMs: 1000, staleMs: 1000 });
  assert.equal(value, 42);
  await assert.rejects(() => stat(store.lockFile), (error) => error.code === "ENOENT");
});

test("withLock takes over a lock held by a dead pid", async (t) => {
  const { store } = await makeTempStore(t);
  await writeFile(
    store.lockFile,
    JSON.stringify({
      pid: 2147483646,
      token: "dead",
      startedAt: new Date().toISOString(),
    }),
  );

  const value = await store.withLock(async () => "ok", { timeoutMs: 1000, staleMs: 120000 });
  assert.equal(value, "ok");
});

test("concurrent appends are serialized by the in-process mutex", async (t) => {
  const { store } = await makeTempStore(t);
  await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      store.appendActive(makeEntry({ text: `entry-${index}` })),
    ),
  );

  const active = await store.loadActive();
  assert.equal(active.length, 10);
  assert.deepEqual(
    active.map((entry) => entry.text).sort(),
    Array.from({ length: 10 }, (_, index) => `entry-${index}`).sort(),
  );
});

test("transaction releases the lock after an error", async (t) => {
  const { store } = await makeTempStore(t);
  await assert.rejects(
    () =>
      store.transaction(async () => {
        throw new Error("transaction failed");
      }),
    /transaction failed/,
  );

  const value = await store.withLock(async () => "still usable", { timeoutMs: 500 });
  assert.equal(value, "still usable");
});

test("snapshot copies store files and writes a manifest", async (t) => {
  const { store } = await makeTempStore(t);
  await writeJsonl(store.paths.activeFile, [
    makeEntry({ text: "one" }),
    makeEntry({ text: "two" }),
    makeEntry({ text: "pending", archived: true }),
  ]);
  await writeJsonl(store.paths.archiveFile, [makeEntry({ text: "old", archived: true })]);

  const snapshot = await store.snapshot("test snapshot");
  assert.ok(snapshot.files.length >= 2);
  assert.equal(snapshot.active_count, 2);
  assert.equal(snapshot.archived_count, 2);

  const manifest = JSON.parse(await readFile(snapshot.backupPath, "utf8"));
  assert.equal(manifest.label, "test snapshot");
  assert.equal(manifest.active_count, 2);
  assert.equal(manifest.archived_count, 2);
  assert.deepEqual(manifest.files, snapshot.files);
  for (const file of manifest.files) {
    await stat(file);
  }

  const second = await store.snapshot("second");
  assert.notEqual(second.timestamp, snapshot.timestamp);
});

test("snapshot works with an empty store", async (t) => {
  const { store } = await makeTempStore(t);
  const snapshot = await store.snapshot("empty");
  assert.equal(snapshot.active_count, 0);
  assert.equal(snapshot.archived_count, 0);
  assert.equal(snapshot.files.length, 0);
  const manifest = JSON.parse(await readFile(snapshot.backupPath, "utf8"));
  assert.deepEqual(manifest.files, []);
});

test("hit logging drains in order, keeps, and clears", async (t) => {
  const { store } = await makeTempStore(t);
  await store.logHits(["a", "b", "a"]);
  await store.logHit("c");

  const kept = await store.drainHits({ keep: true });
  assert.deepEqual(kept, ["a", "b", "c"]);
  assert.ok((await stat(store.hitFile)).size > 0);

  const drained = await store.drainHits();
  assert.deepEqual(drained, ["a", "b", "c"]);
  assert.equal((await stat(store.hitFile)).size, 0);

  await store.logHit("d");
  await store.clearHits();
  assert.equal((await stat(store.hitFile)).size, 0);
});

test("stats count active, pending, archived, categories, and types", async (t) => {
  const { store } = await makeTempStore(t);
  await writeJsonl(store.paths.activeFile, [
    makeEntry({ text: "a", category: "alpha", type: "general" }),
    makeEntry({ text: "b", category: "beta", type: "preference" }),
    makeEntry({
      text: "c",
      category: "alpha",
      type: "general",
      archived: true,
    }),
  ]);
  await writeJsonl(store.paths.archiveFile, [
    makeEntry({ text: "d", archived: true, type: "event" }),
  ]);

  const stats = await store.stats();
  assert.equal(stats.active, 2);
  assert.equal(stats.pendingCompaction, 1);
  assert.equal(stats.archived, 2);
  assert.equal(stats.total, 4);
  assert.ok(stats.fileSizeBytes > 0);
  assert.equal(stats.corruptLines, 0);
  assert.deepEqual(stats.categories, [
    { name: "alpha", count: 1 },
    { name: "beta", count: 1 },
  ]);
  assert.deepEqual(stats.types, [
    { name: "general", count: 1 },
    { name: "preference", count: 1 },
  ]);
});

test("ensureDirs creates memory, snapshot, and proposal directories", async (t) => {
  const { store } = await makeTempStore(t);
  const entries = await readdir(store.memoryDir);
  assert.ok(entries.includes("_snapshots"));
  assert.ok(entries.includes("_proposals"));
  assert.ok(path.isAbsolute(store.memoryDir));
});
