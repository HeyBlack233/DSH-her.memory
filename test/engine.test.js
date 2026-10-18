import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";

import { createEngine } from "../lib/engine.js";
import { readStamp } from "../lib/version-stamp.js";
import {
  backendConfig,
  makeEngine,
  makeEntry,
  makeTempDir,
  readJsonl,
  silentLogger,
  writeJsonl,
  writeRaw,
} from "./helpers.js";
import { startFakeBackend } from "./fake-backend.js";

/** Count non-empty lines in a file, tolerating a missing file. */
async function countLines(file) {
  try {
    const text = await readFile(file, "utf8");
    return text.split("\n").filter((line) => line.trim()).length;
  } catch (error) {
    if (error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

test("createEngine initializes and exposes the stable state shape", async (t) => {
  const home = await makeTempDir(t);
  const engine = createEngine({
    config: { home },
    logger: silentLogger(),
    skills: [{ name: "her-memory" }],
    tools: [{ name: "memory_search" }],
  });
  await engine.ready;

  assert.equal(engine.initError, null);
  const state = await engine.getState();

  assert.deepEqual(state.plugin, { name: "@local/dsh-her-memory", version: "0.1.0" });
  assert.equal(state.paths.home, home);
  assert.equal(state.config.memoryDir, null);
  assert.equal(state.config.backend.apiKey, undefined);
  assert.equal(state.config.backend.embedding.apiKey, undefined);
  assert.equal(state.config.backend.embedding.apiKeySet, false);
  assert.equal(state.config.backend.kind, "none");
  assert.equal(state.status.backend, "none");
  assert.equal(state.status.backendKind, "none");
  assert.equal(state.status.embeddingModel, "bge-m3");
  assert.equal(state.status.chatModel, "qwen2.5:7b");
  assert.equal(state.status.lastMaintenance, null);
  assert.equal(state.status.lastError, null);
  assert.deepEqual(state.stats, {
    active: 0,
    archived: 0,
    pendingCompaction: 0,
    total: 0,
    fileSizeBytes: 0,
    corruptLines: 0,
    categories: [],
    types: [],
  });
  assert.equal(state.skills.length, 1);
  assert.equal(state.tools.length, 1);
  assert.deepEqual(state.capabilities, { skills: true, prompt: true, webApi: true });

  assert.equal(typeof engine.api.getState, "function");
  assert.equal(typeof engine.api.search, "function");
  assert.equal(typeof engine.api.importData, "function");
  const viaApi = await engine.api.getState();
  assert.equal(viaApi.paths.home, home);

  const config = await engine.getConfig();
  assert.equal(config.backend.apiKey, undefined);
  assert.equal(config.backend.embedding.apiKeySet, false);
});

test("engine add/search/list/update/archive/delete work end to end", async (t) => {
  const { engine } = await makeEngine(t);

  const first = await engine.add({
    text: "User likes jasmine tea",
    type: "preference",
    category: "user_profile",
  });
  assert.equal(first.added, true);
  assert.equal(first.hasEmbedding, false);

  const second = await engine.add({
    text: "The nightly python job failed with an error",
    category: "tech_lessons",
  });
  assert.equal(second.added, true);

  const search = await engine.search({ query: "jasmine tea" });
  assert.equal(search.retrievalMode, "keyword");
  assert.equal(search.results[0].id, first.id);
  assert.ok((await countLines(engine.store.hitFile)) >= 1);

  const beforeNoLog = await countLines(engine.store.hitFile);
  await engine.search({ query: "python job", logHits: false });
  assert.equal(await countLines(engine.store.hitFile), beforeNoLog);

  const list = await engine.list({ offset: 0, limit: 10 });
  assert.equal(list.total, 2);
  assert.equal(list.items.length, 2);
  assert.equal(list.offset, 0);
  assert.equal(list.limit, 10);

  const updated = await engine.update({
    id: first.id,
    text: "User prefers jasmine tea every evening",
  });
  assert.equal(updated.updated, true);
  assert.notEqual(updated.newId, first.id);

  const afterUpdate = await engine.list({ includeArchived: false });
  assert.equal(afterUpdate.total, 2);
  const searched = await engine.search({ query: "jasmine tea" });
  assert.equal(searched.results[0].id, updated.newId);

  const archived = await engine.archive({ id: second.id, reason: "done" });
  assert.equal(archived.archived, true);
  const withoutArchived = await engine.list({});
  assert.equal(withoutArchived.total, 1);
  const withArchived = await engine.list({ includeArchived: true });
  assert.equal(withArchived.total, 3);

  const deleted = await engine.delete({ id: second.id, confirm: true });
  assert.equal(deleted.deleted, true);
  const finalList = await engine.list({ includeArchived: true });
  assert.equal(finalList.total, 2);

  assert.ok(
    (await readdir(engine.store.paths.snapshotsDir)).some((name) =>
      name.startsWith("backup_"),
    ),
  );
});

test("list search mode uses a 500-item window and does not log hits", async (t) => {
  const { engine } = await makeEngine(t);
  const entries = Array.from({ length: 25 }, (_, index) =>
    makeEntry({
      id: `m${index}`,
      text: `common topic number ${index}`,
      timestamp: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T10:00:00.000`,
    }),
  );
  await writeJsonl(engine.paths.activeFile, entries);
  engine.store.invalidateCache();

  const listed = await engine.list({ query: "common topic", limit: 100 });
  assert.equal(listed.total, 25);
  assert.equal(listed.items.length, 25);
  assert.equal(await countLines(engine.store.hitFile), 0);

  const searched = await engine.search({ query: "common topic", topK: 500 });
  assert.equal(searched.results.length, engine.config.search.maxTopK);
  assert.equal(await countLines(engine.store.hitFile), engine.config.search.maxTopK);
});

test("saveConfig persists changes and updates runtime redacted state", async (t) => {
  const { engine, home } = await makeEngine(t);
  const state = await engine.saveConfig({
    search: { defaultTopK: 3 },
    ui: { pageSize: 2 },
  });

  assert.equal(state.config.search.defaultTopK, 3);
  assert.equal(state.config.ui.pageSize, 2);
  assert.equal(engine.config.search.defaultTopK, 3);
  assert.equal(engine.paths.home, home);

  const file = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
  assert.equal(file.search.defaultTopK, 3);
  assert.equal(file.ui.pageSize, 2);

  const report = await engine.testBackend({ chat: true });
  assert.equal(report.ok, false);
  assert.equal(report.reason, "disabled");
  const afterProbe = await engine.getState();
  assert.equal(afterProbe.status.backend, "none");
});

test("backend status moves unknown -> ready -> degraded", async (t) => {
  const server = await startFakeBackend({ embedding: [1, 0, 0], chatResponse: "OK" });
  t.after(() => server.close());
  const { engine } = await makeEngine(t, {
    backend: backendConfig(server.baseUrl, "ollama"),
  });

  let state = await engine.getState();
  assert.equal(state.status.backend, "unknown");
  assert.equal(state.status.backendKind, "ollama");

  const healthy = await engine.testBackend({ chat: true });
  assert.equal(healthy.ok, true);
  state = await engine.getState();
  assert.equal(state.status.backend, "ready");

  server.setBehavior("http-error");
  const broken = await engine.testBackend({ chat: true });
  assert.equal(broken.ok, false);
  state = await engine.getState();
  assert.equal(state.status.backend, "degraded");

  // A failing search embedding also degrades a configured backend.
  await engine.saveConfig({ backend: backendConfig(server.baseUrl, "ollama") });
  state = await engine.getState();
  assert.equal(state.status.backend, "unknown");
  await engine.add({ text: "jasmine tea memory" });
  const search = await engine.search({ query: "jasmine tea" });
  assert.equal(search.retrievalMode, "keyword");
  state = await engine.getState();
  assert.equal(state.status.backend, "degraded");
});

test("backfill failures mark the configured backend degraded", async (t) => {
  const server = await startFakeBackend({ embedding: [1, 0, 0] });
  t.after(() => server.close());
  const { engine } = await makeEngine(t, {
    backend: backendConfig(server.baseUrl, "ollama"),
  });

  await engine.add({ text: "memory with an embedding" });
  const entries = await engine.store.loadActive();
  entries[0].embedding = [1, 0, 0];
  await engine.store.transaction(async (tx) => {
    const active = await tx.loadActive({ includeArchived: true });
    active[0].embedding = [1, 0, 0];
    await tx.writeActive(active);
  });

  server.setBehavior("http-error");
  const result = await engine.backfill({ all: true });
  assert.equal(result.failed, 1);
  const state = await engine.getState();
  assert.equal(state.status.backend, "degraded");
  assert.ok(state.status.lastBackfill);
});

test("exportData and importData round-trip and skip duplicates", async (t) => {
  const first = await makeEngine(t);
  await first.engine.add({ text: "first exported fact", category: "user_profile" });
  await first.engine.add({ text: "second exported fact", category: "shared_history" });
  await first.engine.archive({ id: (await first.engine.list({})).items[0].id });

  const exported = await first.engine.exportData();
  assert.equal(typeof exported.active, "string");
  assert.equal(typeof exported.archived, "string");
  assert.ok(exported.version.content_sha256);
  const activeLines = exported.active.trim().split("\n").map((line) => JSON.parse(line));
  const archivedLines = exported.archived
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(activeLines.length, 2);
  assert.equal(archivedLines.length, 0);

  const second = await makeEngine(t);
  const imported = await second.engine.importData({ jsonl: exported.active });
  assert.deepEqual(imported, { imported: 2, skipped: 0, invalid: 0, filled: 0 });

  const listed = await second.engine.list({ includeArchived: true });
  assert.equal(listed.total, 2);

  const again = await second.engine.importData({ jsonl: exported.active });
  assert.deepEqual(again, { imported: 0, skipped: 2, invalid: 0, filled: 0 });

  const mixed = await second.engine.importData({
    jsonl: [
      "not json",
      JSON.stringify({ text: "imported without an id", category: "imported" }),
      JSON.stringify({ foo: "bar" }),
      JSON.stringify({ text: "third imported fact", id: "custom_id" }),
      "",
    ].join("\n"),
    backfill: true,
  });
  assert.equal(mixed.imported, 2);
  assert.equal(mixed.invalid, 2);
  assert.equal(mixed.filled, 0);

  const importedEntry = (await second.engine.list({ includeArchived: true })).items.find(
    (entry) => entry.id === "custom_id",
  );
  assert.ok(importedEntry);
  assert.equal(importedEntry.text, "third imported fact");

  const noIdEntry = (await second.engine.list({ includeArchived: true })).items.find(
    (entry) => entry.text === "imported without an id",
  );
  assert.ok(noIdEntry.id.startsWith("mem_"));
});

test("importData rejects a non-string payload", async (t) => {
  const { engine } = await makeEngine(t);
  await assert.rejects(
    () => engine.importData({ jsonl: 123 }),
    (error) => error.code === "INVALID_INPUT" && error.details.path === "jsonl",
  );
});

test("engine.propose/listProposals/getProposal/stamp work through the facade", async (t) => {
  const { engine } = await makeEngine(t);
  await engine.add({ text: "first fact about tea", type: "preference" });
  await engine.add({ text: "second fact about tea", type: "preference" });

  const proposal = await engine.propose();
  assert.equal(proposal.status, "pending_review");
  assert.match(proposal.proposal_id, /^prop_/);

  const list = await engine.listProposals();
  assert.equal(list.length, 1);
  assert.equal(list[0].proposal_id, proposal.proposal_id);

  const fetched = await engine.getProposal(proposal.proposal_id);
  assert.equal(fetched.proposal_id, proposal.proposal_id);
  await assert.rejects(
    () => engine.getProposal("missing"),
    (error) => error.code === "PROPOSAL_NOT_FOUND",
  );

  const state = await engine.getState();
  assert.equal(state.status.lastProposal, proposal.generated_at);

  const stamp = await engine.stamp();
  assert.equal(stamp.entries_total, 2);
  assert.deepEqual(await readStamp(engine.store), stamp);
});

test("auto maintenance runs once, updates state, and respects the interval", async (t) => {
  const { engine } = await makeEngine(t);
  await engine.add({ text: "a memory to maintain" });

  const [first, concurrent] = await Promise.all([
    engine.maybeAutoMaintain(),
    engine.maybeAutoMaintain(),
  ]);
  assert.strictEqual(first, concurrent);
  assert.equal(first.active, 1);
  assert.equal(first.decayed, 1);

  const state = await engine.getState();
  assert.ok(state.status.lastMaintenance);

  const second = await engine.maybeAutoMaintain();
  assert.equal(second, null);
  assert.equal(await engine.isMaintenanceDue(), false);
});

test("an invalid config.json is captured, exposed, and recoverable through saveConfig", async (t) => {
  const home = await makeTempDir(t);
  await writeRaw(path.join(home, "config.json"), "{ broken json");

  // Must not throw at construction time.
  const engine = createEngine({ config: { home }, logger: silentLogger() });
  await engine.ready;
  assert.ok(engine.initError);
  assert.equal(engine.initError.code, "INVALID_INPUT");

  const brokenState = await engine.getState();
  assert.equal(brokenState.status.backend, "unknown");
  assert.equal(brokenState.status.lastError.code, "INVALID_INPUT");
  assert.equal(brokenState.config.backend.kind, "none");
  assert.equal(brokenState.paths.home, home);

  await assert.rejects(
    () => engine.search({ query: "anything" }),
    (error) => error.code === "INVALID_INPUT",
  );

  const recovered = await engine.saveConfig({ search: { defaultTopK: 4 } });
  assert.equal(engine.initError, null);
  assert.equal(recovered.config.search.defaultTopK, 4);
  assert.equal(recovered.status.backend, "none");
  assert.equal(recovered.status.lastError, null);

  const loaded = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
  assert.equal(loaded.search.defaultTopK, 4);
  assert.ok((await readdir(home)).includes("memories"));

  const added = await engine.add({ text: "works after repair" });
  assert.equal(added.added, true);
});

test("engine state reflects the default paths and stamp after writes", async (t) => {
  const { engine } = await makeEngine(t);
  await engine.add({ text: "stamp me" });
  const stamp = await readStamp(engine.store);
  assert.equal(stamp.entries_total, 1);
  const state = await engine.getState();
  assert.equal(state.stats.active, 1);
  assert.equal(state.status.lastMaintenance, null);
});

test("engine.delete requires an explicit confirmation", async (t) => {
  const { engine } = await makeEngine(t);
  const added = await engine.add({ text: "delete me" });
  await assert.rejects(
    () => engine.delete({ id: added.id }),
    (error) => error.code === "INVALID_INPUT" && error.details.path === "confirm",
  );
  const state = await engine.getState();
  assert.equal(state.stats.active, 1);
  await stat(engine.paths.activeFile);
});

test("search.maxResultChars caps the total returned text", async (t) => {
  const { engine } = await makeEngine(t, { search: { maxResultChars: 20 } });
  await engine.add({ text: "jasmine tea is preferred in the evening" });
  await engine.add({ text: "jasmine tea is also preferred at noon" });

  const result = await engine.search({ query: "jasmine tea", topK: 5 });
  const totalChars = result.results.reduce(
    (total, item) => total + item.text.length,
    0,
  );
  assert.ok(totalChars <= 20);
  assert.ok(result.results.length >= 1);
  assert.equal(result.results[0].text.length, 20);
});

test("search with topK zero returns an empty envelope", async (t) => {
  const { engine } = await makeEngine(t);
  await engine.add({ text: "jasmine tea memory" });
  const result = await engine.search({ query: "jasmine tea", topK: 0 });
  assert.equal(result.retrievalMode, "empty");
  assert.deepEqual(result.results, []);
});
