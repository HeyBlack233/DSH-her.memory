import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";

import {
  DEFAULT_CONFIG,
  DEFAULT_STATE,
  getConfigHome,
  loadConfig,
  loadState,
  redactConfig,
  resolveHome,
  resolvePaths,
  saveConfig,
  saveState,
  validateConfig,
} from "../lib/config.js";
import { HermemoryError } from "../lib/errors.js";
import { makeTempDir, readJsonFile, writeRaw } from "./helpers.js";

test("DEFAULT_CONFIG carries the documented defaults", () => {
  assert.equal(DEFAULT_CONFIG.schemaVersion, 1);
  assert.equal(DEFAULT_CONFIG.memoryDir, null);
  assert.equal(DEFAULT_CONFIG.backend.kind, "none");
  assert.equal(DEFAULT_CONFIG.backend.embedding.model, "bge-m3");
  assert.equal(DEFAULT_CONFIG.backend.chat.model, "qwen2.5:7b");
  assert.equal(DEFAULT_CONFIG.backend.embedding.timeoutMs, 15000);
  assert.equal(DEFAULT_CONFIG.search.defaultTopK, 8);
  assert.equal(DEFAULT_CONFIG.search.maxTopK, 20);
  assert.equal(DEFAULT_CONFIG.search.maxResultChars, 6000);
  assert.equal(DEFAULT_CONFIG.search.rrfK, 60);
  assert.equal(DEFAULT_CONFIG.maintenance.energyInitial, 2.0);
  assert.equal(DEFAULT_CONFIG.maintenance.energyDecay, 0.97);
  assert.equal(DEFAULT_CONFIG.maintenance.energyHitBoost, 0.2);
  assert.equal(DEFAULT_CONFIG.maintenance.archiveDays, 90);
  assert.equal(DEFAULT_CONFIG.consolidation.triggerCount, 100);
  assert.equal(DEFAULT_CONFIG.consolidation.triggerSizeMb, 2.5);
  assert.equal(DEFAULT_CONFIG.consolidation.triggerDays, 30);
  assert.equal(DEFAULT_CONFIG.consolidation.typeThresholds.general, 0.8);
  assert.equal(DEFAULT_CONFIG.consolidation.energyArchiveThreshold, 0.5);
  assert.equal(DEFAULT_CONFIG.consolidation.maxJudgePairs, 60);
  assert.equal(DEFAULT_CONFIG.ui.pageSize, 50);
});

test("loadConfig creates config.json and resolves the default memory dir", async (t) => {
  const home = await makeTempDir(t);
  const config = await loadConfig({ home });

  assert.equal(config.memoryDir, null);
  assert.equal(config.backend.kind, "none");
  assert.equal(getConfigHome(config), home);

  const written = await readJsonFile(path.join(home, "config.json"));
  assert.deepEqual(written, DEFAULT_CONFIG);

  const paths = resolvePaths(config);
  assert.equal(paths.home, home);
  assert.equal(paths.configFile, path.join(home, "config.json"));
  assert.equal(paths.memoryDir, path.join(home, "memories"));
  assert.equal(paths.activeFile, path.join(home, "memories", "semantic_memories.jsonl"));
  assert.equal(paths.archiveFile, path.join(home, "memories", "archived_memories.jsonl"));
  assert.equal(paths.hitFile, path.join(home, "memories", "retrieval_hits.jsonl"));
  assert.equal(paths.versionFile, path.join(home, "memories", "semantic_version.json"));
  assert.equal(paths.snapshotsDir, path.join(home, "memories", "_snapshots"));
  assert.equal(paths.proposalsDir, path.join(home, "memories", "_proposals"));
});

test("loadConfig deep-merges over defaults and preserves unknown keys", async (t) => {
  const home = await makeTempDir(t);
  await writeRaw(
    path.join(home, "config.json"),
    JSON.stringify({
      backend: { kind: "none" },
      search: { defaultTopK: 5 },
      customSection: { keep: "me" },
    }),
  );

  const config = await loadConfig({ home });
  assert.equal(config.search.defaultTopK, 5);
  assert.equal(config.search.maxTopK, 20);
  assert.equal(config.consolidation.typeThresholds.preference, 0.9);
  assert.deepEqual(config.customSection, { keep: "me" });
  assert.equal(config.memoryDir, null);
});

test("a relative memoryDir is resolved against the home", async (t) => {
  const home = await makeTempDir(t);
  await writeRaw(
    path.join(home, "config.json"),
    JSON.stringify({ memoryDir: "custom-memory", search: { defaultTopK: 4 } }),
  );
  const config = await loadConfig({ home });
  const paths = resolvePaths(config);
  assert.equal(paths.memoryDir, path.join(home, "custom-memory"));
  assert.equal(paths.activeFile, path.join(home, "custom-memory", "semantic_memories.jsonl"));
});

test("a persisted home key is ignored and never written back", async (t) => {
  const home = await makeTempDir(t);
  const other = path.join(home, "elsewhere");
  await writeRaw(
    path.join(home, "config.json"),
    JSON.stringify({ home: other, search: { defaultTopK: 3 } }),
  );

  const config = await loadConfig({ home });
  assert.equal(config.home, undefined);
  assert.equal(resolvePaths(config).home, home);

  await saveConfig({ ui: { pageSize: 10 } }, { home });
  const saved = await readJsonFile(path.join(home, "config.json"));
  assert.equal(saved.home, undefined);
  assert.equal(saved.ui.pageSize, 10);
  assert.equal(saved.search.defaultTopK, 3);
});

test("resolveHome honors an explicit home, then DSH_HOME", () => {
  assert.equal(resolveHome({ home: "/tmp/explicit" }), "/tmp/explicit");
  assert.equal(
    resolveHome({}, { DSH_HOME: "/tmp/dsh-home" }),
    path.join("/tmp/dsh-home", "her-memory"),
  );
});

test("validateConfig reports the JSON path of the first bad value", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.backend.kind = "bogus";
  assert.throws(
    () => validateConfig(config),
    (error) => {
      assert.ok(error instanceof HermemoryError);
      assert.equal(error.code, "INVALID_INPUT");
      assert.equal(error.details.path, "backend.kind");
      return true;
    },
  );

  const topK = structuredClone(DEFAULT_CONFIG);
  topK.search.defaultTopK = 30;
  assert.throws(
    () => validateConfig(topK),
    (error) => error.code === "INVALID_INPUT" && error.details.path === "search.defaultTopK",
  );

  const threshold = structuredClone(DEFAULT_CONFIG);
  threshold.consolidation.typeThresholds.general = 1.5;
  assert.throws(
    () => validateConfig(threshold),
    (error) =>
      error.code === "INVALID_INPUT" &&
      error.details.path === "consolidation.typeThresholds.general",
  );
});

test("empty endpoint URL/model is allowed only when the backend is disabled", async (t) => {
  const home = await makeTempDir(t);
  const disabled = await saveConfig(
    {
      backend: {
        kind: "none",
        embedding: { url: "", model: "" },
        chat: { url: "", model: "" },
      },
    },
    { home },
  );
  assert.equal(disabled.backend.embedding.url, "");

  await assert.rejects(
    () =>
      saveConfig(
        {
          backend: {
            kind: "ollama",
            embedding: { url: "", model: "" },
          },
        },
        { home },
      ),
    (error) =>
      error.code === "INVALID_INPUT" && error.details.path === "backend.embedding.url",
  );
});

test("config.json is written atomically with owner-only permissions", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permissions only");
    return;
  }
  const home = await makeTempDir(t);
  await saveConfig({ search: { defaultTopK: 3 } }, { home });
  const fileStat = await stat(path.join(home, "config.json"));
  assert.equal(fileStat.mode & 0o777, 0o600);
});

test("loadConfig rejects corrupt or invalid JSON", async (t) => {
  const home = await makeTempDir(t);
  await writeRaw(path.join(home, "config.json"), "{ this is not json");
  await assert.rejects(
    () => loadConfig({ home }),
    (error) => error.code === "INVALID_INPUT" && error.details.path === "config.json",
  );

  await writeRaw(path.join(home, "config.json"), JSON.stringify({ search: [] }));
  await assert.rejects(
    () => loadConfig({ home }),
    (error) => error.code === "INVALID_INPUT" && error.details.path === "search",
  );
});

test("saveConfig can repair a corrupt config from defaults", async (t) => {
  const home = await makeTempDir(t);
  await writeRaw(path.join(home, "config.json"), "{ broken");
  const repaired = await saveConfig({ search: { defaultTopK: 2 } }, { home });
  assert.equal(repaired.search.defaultTopK, 2);
  assert.equal(repaired.search.maxTopK, 20);
  const loaded = await loadConfig({ home });
  assert.equal(loaded.search.defaultTopK, 2);
});

test("redactConfig removes API keys and reports whether they are set", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.backend.kind = "llama-cpp";
  config.backend.embedding.apiKey = "secret-embed";
  config.backend.chat.apiKey = "secret-chat";

  const redacted = redactConfig(config);
  assert.equal(redacted.backend.embedding.apiKey, undefined);
  assert.equal(redacted.backend.chat.apiKey, undefined);
  assert.equal(redacted.backend.embedding.apiKeySet, true);
  assert.equal(redacted.backend.chat.apiKeySet, true);

  const empty = structuredClone(DEFAULT_CONFIG);
  const emptyRedacted = redactConfig(empty);
  assert.equal(emptyRedacted.backend.embedding.apiKeySet, false);
  assert.equal(emptyRedacted.backend.chat.apiKeySet, false);

  // The input object is not mutated.
  assert.equal(config.backend.embedding.apiKey, "secret-embed");
});

test("state IO tolerates missing and corrupt files and writes valid JSON", async (t) => {
  const home = await makeTempDir(t);
  assert.deepEqual(await loadState({ home }), DEFAULT_STATE);

  await writeRaw(path.join(home, "state.json"), "{ corrupt");
  assert.deepEqual(await loadState({ home }), DEFAULT_STATE);

  const saved = await saveState(
    { lastMaintenance: "2026-08-14T10:00:00.000", custom: 1 },
    { home },
  );
  assert.equal(saved.lastMaintenance, "2026-08-14T10:00:00.000");
  assert.equal(saved.custom, 1);
  assert.equal(saved.schemaVersion, 1);

  const loaded = await loadState({ home });
  assert.equal(loaded.lastMaintenance, "2026-08-14T10:00:00.000");
  assert.equal(loaded.lastBackfillAt, null);
  assert.equal(loaded.lastProposalAt, null);
  assert.equal(loaded.lastError, null);

  const content = await readFile(path.join(home, "state.json"), "utf8");
  assert.ok(content.endsWith("\n"));
});

test("saveConfig without an options home stays in the last loaded home", async (t) => {
  const home = await makeTempDir(t);
  await loadConfig({ home });
  await saveConfig({ ui: { pageSize: 7 } });
  const saved = await readJsonFile(path.join(home, "config.json"));
  assert.equal(saved.ui.pageSize, 7);
});
