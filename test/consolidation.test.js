import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";

import { loadState } from "../lib/config.js";
import {
  executeProposal,
  generateProposal,
  getProposal,
  listProposals,
  restoreProposal,
} from "../lib/consolidation.js";
import { createBackend } from "../lib/embeddings.js";
import { HermemoryError } from "../lib/errors.js";
import { readStamp } from "../lib/version-stamp.js";
import { backendConfig, makeConfig, makeEntry, makeTempStore, writeJsonl } from "./helpers.js";
import { startFakeBackend } from "./fake-backend.js";

/**
 * Seed a store with two similar preferences, one stale technical memory, and
 * one unrelated event, then return a backend wired to a fake server.
 */
async function setup(t, { chatResponse = "YES", overrides = {} } = {}) {
  const { store, config, dir } = await makeTempStore(t, overrides);
  const now = Date.now();

  const entries = {
    a: makeEntry({
      id: "a",
      text: "User likes jasmine tea",
      type: "preference",
      category: "user_profile",
      embedding: [1, 0],
      energy: 1.2,
      last_hit: new Date(now).toISOString(),
    }),
    b: makeEntry({
      id: "b",
      text: "User prefers jasmine tea in the evening",
      type: "preference",
      category: "user_profile",
      embedding: [0.99, 0.05],
      energy: 2.0,
      last_hit: new Date(now).toISOString(),
    }),
    c: makeEntry({
      id: "c",
      text: "Fixed a python venv dependency bug",
      type: "general",
      category: "tech_lessons",
      embedding: [0, 1],
      energy: 0.2,
      last_hit: new Date(now - 200 * 86400000).toISOString(),
    }),
    d: makeEntry({
      id: "d",
      text: "A completely unrelated event happened",
      type: "event",
      category: "shared_history",
      embedding: [0, 1],
      energy: 2.0,
      last_hit: new Date(now).toISOString(),
    }),
  };

  await writeJsonl(store.paths.activeFile, Object.values(entries));
  await writeJsonl(store.paths.archiveFile, []);
  store.invalidateCache();

  const server = await startFakeBackend({ chatResponse, embedding: [0.5, 0.5] });
  t.after(() => server.close());
  const backend = createBackend(
    makeConfig(dir, { backend: backendConfig(server.baseUrl, "ollama") }),
  );

  return { store, config, dir, entries, server, backend };
}

test("generateProposal builds merge, archive, and skill candidates", async (t) => {
  const { store, config, backend, entries } = await setup(t);
  const proposal = await generateProposal(store, config, backend);

  assert.match(proposal.proposal_id, /^prop_\d{8}_\d{6}_[0-9a-f]+$/);
  assert.match(proposal.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(proposal.trigger_reason, "manual");
  assert.equal(proposal.status, "pending_review");
  assert.deepEqual(proposal.current_stats, {
    active_count: 4,
    file_size_mb: Math.round(((await stat(store.paths.activeFile)).size / (1024 * 1024)) * 100) / 100,
    by_type: { preference: 2, general: 1, event: 1 },
  });

  assert.equal(proposal.merge_groups.length, 1);
  const group = proposal.merge_groups[0];
  assert.equal(group.group_id, "mg_0");
  assert.equal(group.type, "preference");
  assert.deepEqual(group.merged_from.sort(), [entries.a.id, entries.b.id].sort());
  assert.equal(group.proposed_text, entries.b.text);
  assert.equal(group.status, "pending_review");
  assert.ok(group.similarity_max > 0.9);

  assert.deepEqual(proposal.archive_candidates.map((candidate) => candidate.id), [entries.c.id]);
  assert.ok(proposal.archive_candidates[0].energy < 0.5);
  assert.ok(proposal.archive_candidates[0].days_unhit >= 200);

  assert.deepEqual(proposal.skill_candidates.map((candidate) => candidate.id), [entries.c.id]);
  assert.match(proposal.skill_candidates[0].reason, /skill/);

  assert.equal(proposal.summary.merge_groups_count, 1);
  assert.equal(proposal.summary.archive_candidates_count, 1);
  assert.equal(proposal.summary.skill_candidates_count, 1);
  assert.equal(proposal.summary.estimated_reduction, 1);

  const file = path.join(store.paths.proposalsDir, `${proposal.proposal_id}.json`);
  const written = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(written, proposal);

  const state = await loadState({ home: store.paths.home });
  assert.equal(state.lastProposalAt, proposal.generated_at);

  const listed = await listProposals(store);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], {
    proposal_id: proposal.proposal_id,
    generated_at: proposal.generated_at,
    status: "pending_review",
    trigger_reason: "manual",
    counts: { merge_groups: 1, archive_candidates: 1, skill_candidates: 1 },
  });

  const fetched = await getProposal(store, proposal.proposal_id);
  assert.deepEqual(fetched, proposal);
});

test("an LLM judge NO response suppresses merge groups", async (t) => {
  const { store, config, backend } = await setup(t, { chatResponse: "NO" });
  const proposal = await generateProposal(store, config, backend);
  assert.deepEqual(proposal.merge_groups, []);
  assert.equal(proposal.archive_candidates.length, 1);
});

test("llmJudge false produces groups from cosine alone", async (t) => {
  const { store, config, backend } = await setup(t, {
    overrides: { consolidation: { llmJudge: false } },
  });
  const proposal = await generateProposal(store, config, backend);
  assert.equal(proposal.merge_groups.length, 1);
});

test("an unavailable LLM judge suppresses merge groups but keeps the proposal", async (t) => {
  const { store, config } = await setup(t);
  const proposal = await generateProposal(store, config, { kind: "none" });
  assert.deepEqual(proposal.merge_groups, []);
  assert.equal(proposal.archive_candidates.length, 1);
  assert.equal(proposal.skill_candidates.length, 1);
});

test("unknown proposals raise PROPOSAL_NOT_FOUND", async (t) => {
  const { store } = await setup(t);
  await assert.rejects(
    () => getProposal(store, "prop_missing"),
    (error) => error.code === "PROPOSAL_NOT_FOUND" && error.status === 404,
  );
  await assert.rejects(
    () => getProposal(store, "../escape"),
    (error) => error.code === "PROPOSAL_NOT_FOUND",
  );
});

test("executeProposal rejects unknown or empty selections before snapshotting", async (t) => {
  const { store, config, backend } = await setup(t);
  const proposal = await generateProposal(store, config, backend);
  const before = (await stat(store.paths.snapshotsDir)).isDirectory();
  assert.equal(before, true);

  await assert.rejects(
    () => executeProposal(store, config, backend, { id: proposal.proposal_id, groups: [] }),
    (error) => error.code === "INVALID_INPUT",
  );
  await assert.rejects(
    () =>
      executeProposal(store, config, backend, {
        id: proposal.proposal_id,
        archiveIds: ["not-in-this-proposal"],
      }),
    (error) => error.code === "INVALID_INPUT",
  );

  const current = await getProposal(store, proposal.proposal_id);
  assert.equal(current.status, "pending_review");
  assert.equal(current.results, undefined);
});

test("executeProposal merges selected members with edited text and archives candidates", async (t) => {
  const { store, config, backend, entries } = await setup(t);
  const proposal = await generateProposal(store, config, backend);
  const editedText = "Merged: the owner loves jasmine tea in the evening";

  const result = await executeProposal(store, config, backend, {
    id: proposal.proposal_id,
    groups: ["mg_0"],
    archiveIds: [entries.c.id],
    mergedTexts: { mg_0: editedText },
  });

  assert.equal(result.status, "executed");
  assert.equal(result.merged_count, 1);
  assert.equal(result.archived_count, 1);
  assert.deepEqual(result.warnings, []);
  await stat(result.backup_path);

  const active = await store.loadActive();
  const merged = active.find((entry) => entry.text === editedText);
  assert.ok(merged);
  assert.equal(merged.type, "preference");
  assert.equal(merged.category, "user_profile");
  assert.deepEqual(merged.merged_from.sort(), [entries.a.id, entries.b.id].sort());
  assert.equal(merged.merge_proposal, proposal.proposal_id);
  assert.deepEqual(merged.origin, { source: "consolidation" });
  assert.equal(merged.energy, 3);
  assert.deepEqual(merged.embedding, [0.5, 0.5]);
  assert.equal(active.length, 2);

  const archived = await store.loadArchive();
  assert.equal(archived.length, 3);
  const a = archived.find((entry) => entry.id === entries.a.id);
  const b = archived.find((entry) => entry.id === entries.b.id);
  const c = archived.find((entry) => entry.id === entries.c.id);
  assert.equal(a.merged_into, merged.id);
  assert.equal(a.archive_reason, `merged:${proposal.proposal_id}`);
  assert.equal(b.merged_into, merged.id);
  assert.equal(c.archived, true);
  assert.match(c.archive_reason, /archived by proposal/);

  const stored = await getProposal(store, proposal.proposal_id);
  assert.equal(stored.status, "executed");
  assert.match(stored.executed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(stored.results.merged_count, 1);
  assert.equal(stored.results.archived_count, 1);
  assert.equal(stored.results.backup_path, result.backup_path);

  const stamp = await readStamp(store);
  assert.equal(stamp.entries_total, 5);
  assert.equal(stamp.entries_archived, 3);

  await assert.rejects(
    () =>
      executeProposal(store, config, backend, {
        id: proposal.proposal_id,
        groups: ["mg_0"],
      }),
    (error) => error.code === "INVALID_INPUT" && error.status === 409,
  );
});

test("restoreProposal rolls back an executed proposal and blocks re-execution", async (t) => {
  const { store, config, backend, entries } = await setup(t);
  const proposal = await generateProposal(store, config, backend);
  await executeProposal(store, config, backend, {
    id: proposal.proposal_id,
    groups: ["mg_0"],
    archiveIds: [entries.c.id],
  });

  const result = await restoreProposal(store, config, proposal.proposal_id);
  assert.equal(result.restored, true);
  assert.equal(result.active, 4);
  assert.equal(result.archived, 0);

  const active = await store.loadActive({ includeArchived: true });
  assert.deepEqual(active.map((entry) => entry.id).sort(), ["a", "b", "c", "d"]);
  assert.equal((await store.loadArchive()).length, 0);

  const stored = await getProposal(store, proposal.proposal_id);
  assert.equal(stored.status, "restored");
  assert.match(stored.restored_at, /^\d{4}-\d{2}-\d{2}T/);

  await assert.rejects(
    () =>
      executeProposal(store, config, backend, {
        id: proposal.proposal_id,
        groups: ["mg_0"],
      }),
    (error) => error.code === "INVALID_INPUT" && error.status === 409,
  );
});

test("restoreProposal rejects proposals that were never executed", async (t) => {
  const { store, config, backend } = await setup(t);
  const proposal = await generateProposal(store, config, backend);
  await assert.rejects(
    () => restoreProposal(store, config, proposal.proposal_id),
    (error) => {
      assert.ok(error instanceof HermemoryError);
      assert.equal(error.code, "PROPOSAL_NOT_EXECUTED");
      assert.equal(error.status, 409);
      return true;
    },
  );
});

test("restoreProposal reports a missing snapshot", async (t) => {
  const { store, config, backend } = await setup(t);
  const proposal = await generateProposal(store, config, backend);
  await executeProposal(store, config, backend, {
    id: proposal.proposal_id,
    groups: ["mg_0"],
  });

  const file = path.join(store.paths.proposalsDir, `${proposal.proposal_id}.json`);
  const stored = JSON.parse(await readFile(file, "utf8"));
  stored.results.backup_path = path.join(store.paths.snapshotsDir, "backup_missing.json");
  await writeJsonl(path.join(store.paths.snapshotsDir, "unused.jsonl"), []);

  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

  await assert.rejects(
    () => restoreProposal(store, config, proposal.proposal_id),
    (error) => error.code === "SNAPSHOT_NOT_FOUND",
  );
});
