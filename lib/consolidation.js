/**
 * Proposal-based consolidation: draft, review, execute, restore.
 *
 * Nothing moves without an explicit execute call. Every execute takes a
 * snapshot first, and restore replays that snapshot under the store lock.
 *
 * @module consolidation
 */

import crypto from "node:crypto";
import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";

import { loadState, saveState } from "./config.js";
import { HermemoryError } from "./errors.js";
import { writeStamp } from "./version-stamp.js";
import {
  atomicWrite,
  compactLocalTimestamp,
  cosine,
  deepClone,
  isPlainObject,
  localIsoNow,
  newMemoryId,
  parseDate,
} from "./util.js";

/** Keywords that mark a general memory as a possible skill. */
const SKILL_KEYWORDS = [
  "bug",
  "error",
  "fix",
  "config",
  "environment",
  "dependency",
  "venv",
  "python",
  "proxy",
  "gpu",
  "api",
  "quota",
];

/** @returns {string} Random hex suffix. */
function randomHex(bytes = 3) {
  return crypto.randomBytes(bytes).toString("hex");
}

/** @returns {number} Fresh default energy. */
function initialEnergy(config) {
  const value = config?.maintenance?.energyInitial;
  return Number.isFinite(value) ? value : 2.0;
}

/** Valid embedding check. */
function validVector(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

/** Chat is available only for an enabled backend implementing chat. */
function chatUsable(backend) {
  return Boolean(backend && backend.kind !== "none" && typeof backend.chat === "function");
}

/** Embedding is available only for an enabled backend implementing embed. */
function embedUsable(backend) {
  return Boolean(backend && backend.kind !== "none" && typeof backend.embed === "function");
}

/** Truncate a long message for logging. */
function shortMessage(error) {
  return String(error?.message || error).slice(0, 300);
}

/** Log a warning when a logger is present. */
function warn(logger, message, error) {
  try {
    if (logger && typeof logger.warn === "function") {
      logger.warn(message, error);
    }
  } catch {
    // Logging is best-effort.
  }
}

/** Validate a proposal id so it cannot escape the proposals directory. */
function assertProposalId(id) {
  const proposalId = typeof id === "string" ? id.trim() : "";
  if (!proposalId || !/^[A-Za-z0-9_.-]+$/.test(proposalId)) {
    throw new HermemoryError("PROPOSAL_NOT_FOUND", `Proposal not found: ${proposalId || id}`, {
      status: 404,
      details: { id: proposalId || String(id ?? "") },
    });
  }
  return proposalId;
}

/** Path of a proposal file. */
function proposalFile(store, id) {
  return path.join(store.paths.proposalsDir, `${id}.json`);
}

/** Read a proposal or throw PROPOSAL_NOT_FOUND. */
async function readProposal(store, id) {
  const proposalId = assertProposalId(id);
  let text;
  try {
    text = await readFile(proposalFile(store, proposalId), "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new HermemoryError("PROPOSAL_NOT_FOUND", `Proposal not found: ${proposalId}`, {
        status: 404,
        details: { id: proposalId },
      });
    }
    throw new HermemoryError("STORE_IO", `Failed to read proposal ${proposalId}`, {
      status: 500,
      details: { id: proposalId },
      cause: error,
    });
  }

  let proposal;
  try {
    proposal = JSON.parse(text);
  } catch (error) {
    throw new HermemoryError("PROPOSAL_NOT_FOUND", `Proposal is corrupt: ${proposalId}`, {
      status: 404,
      details: { id: proposalId, reason: shortMessage(error) },
      cause: error,
    });
  }
  if (!isPlainObject(proposal)) {
    throw new HermemoryError("PROPOSAL_NOT_FOUND", `Proposal is not an object: ${proposalId}`, {
      status: 404,
      details: { id: proposalId },
    });
  }
  return proposal;
}

/** Atomically write a proposal. */
async function writeProposal(store, proposal) {
  await atomicWrite(
    proposalFile(store, proposal.proposal_id),
    `${JSON.stringify(proposal, null, 2)}\n`,
    0o600,
  );
  return proposal;
}

/** Longest text among group members. */
function longestText(entries) {
  let best = "";
  for (const entry of entries) {
    const text = typeof entry.text === "string" ? entry.text : "";
    if (text.length > best.length) {
      best = text;
    }
  }
  return best;
}

/** Parse JSONL text, skipping invalid lines. */
function parseJsonl(text) {
  const entries = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (isPlainObject(parsed)) {
        entries.push(parsed);
      }
    } catch {
      // A snapshot was written by this plugin; skip damaged lines defensively.
    }
  }
  return entries;
}

/** Determine the write trigger from counts, size, or file age. */
async function triggerReason(store, config, activeCount, fileSizeMb) {
  const consolidation = config?.consolidation || {};
  const triggerCount = Number.isFinite(consolidation.triggerCount)
    ? consolidation.triggerCount
    : 100;
  const triggerSizeMb = Number.isFinite(consolidation.triggerSizeMb)
    ? consolidation.triggerSizeMb
    : 2.5;
  const triggerDays = Number.isFinite(consolidation.triggerDays)
    ? consolidation.triggerDays
    : 30;

  if (activeCount >= triggerCount) {
    return `active memory count (${activeCount}) >= trigger count (${triggerCount})`;
  }
  if (fileSizeMb >= triggerSizeMb) {
    return `file size (${fileSizeMb.toFixed(2)} MB) >= trigger size (${triggerSizeMb} MB)`;
  }
  try {
    const stats = await stat(store.activeFile);
    const days = (Date.now() - stats.mtimeMs) / 86400000;
    if (days >= triggerDays) {
      return `store untouched for ${days.toFixed(1)} days >= trigger days (${triggerDays})`;
    }
  } catch {
    // Missing store file: fall through to manual.
  }
  return "manual";
}

/** Build merge groups from accepted pairs using union-find. */
function buildMergeGroups(items, acceptedPairs, type) {
  if (acceptedPairs.length === 0) {
    return [];
  }

  const parent = items.map((_, index) => index);
  const find = (index) => {
    let current = index;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]];
      current = parent[current];
    }
    return current;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot;
    }
  };

  for (const pair of acceptedPairs) {
    union(pair.left, pair.right);
  }

  const clusters = new Map();
  items.forEach((_, index) => {
    const root = find(index);
    if (!clusters.has(root)) {
      clusters.set(root, []);
    }
    clusters.get(root).push(index);
  });

  const groups = [];
  for (const indexes of clusters.values()) {
    if (indexes.length < 2) {
      continue;
    }
    const members = indexes.map((index) => items[index].entry);
    const memberSet = new Set(indexes);
    const similarityMax = acceptedPairs
      .filter((pair) => memberSet.has(pair.left) && memberSet.has(pair.right))
      .reduce((maximum, pair) => Math.max(maximum, pair.similarity), 0);
    const mergedFrom = members
      .map((entry) => entry.id)
      .filter((id) => typeof id === "string" && id);
    groups.push({
      group_id: `mg_${groups.length}`,
      type,
      merged_from: mergedFrom,
      memories: deepClone(members),
      proposed_text: longestText(members),
      status: "pending_review",
      similarity_max: Math.round(similarityMax * 1000) / 1000,
    });
  }
  return groups;
}

/**
 * Generate a curation proposal. This is a read-only pass over the store.
 *
 * @param {import("./store.js").JsonlStore} store Store.
 * @param {object} config Configuration.
 * @param {object|null} backend Backend adapter (embeddings and optional judge).
 * @param {object|null} [logger] Optional logger.
 * @returns {Promise<object>} The written proposal.
 */
export async function generateProposal(store, config, backend, logger = null) {
  const active = await store.loadActive();
  const stats = await store.stats();
  const fileSizeMb = stats.fileSizeBytes / (1024 * 1024);
  const reason = await triggerReason(store, config, active.length, fileSizeMb);

  const consolidation = config?.consolidation || {};
  const thresholds = isPlainObject(consolidation.typeThresholds)
    ? consolidation.typeThresholds
    : {};
  const maxJudgePairs = Number.isFinite(consolidation.maxJudgePairs)
    ? Math.max(1, Math.floor(consolidation.maxJudgePairs))
    : 60;
  const useJudge = consolidation.llmJudge !== false;

  const byType = new Map();
  for (const entry of active) {
    const type = typeof entry.type === "string" && entry.type ? entry.type : "general";
    if (!byType.has(type)) {
      byType.set(type, []);
    }
    byType.get(type).push(entry);
  }

  const vectors = new Map();
  for (const entry of active) {
    if (validVector(entry.embedding)) {
      vectors.set(entry, entry.embedding);
    }
  }

  if (embedUsable(backend)) {
    for (const entry of active) {
      if (vectors.has(entry)) {
        continue;
      }
      const text = typeof entry.text === "string" ? entry.text.trim() : "";
      if (!text) {
        continue;
      }
      try {
        const vector = await backend.embed(text);
        if (validVector(vector)) {
          vectors.set(entry, vector);
        }
      } catch (error) {
        warn(logger, `Failed to embed memory ${entry.id || "entry"} for consolidation`, error);
      }
    }
  }

  let judgeUnavailable = false;
  let pairBudget = maxJudgePairs;
  const mergeGroups = [];

  outer: for (const [type, entries] of byType) {
    if (entries.length < 2) {
      continue;
    }
    const threshold = Number.isFinite(thresholds[type]) ? thresholds[type] : 0.8;
    const items = [];
    for (const entry of entries) {
      const vector = vectors.get(entry);
      if (validVector(vector)) {
        items.push({ entry, vector });
      }
    }
    if (items.length < 2) {
      continue;
    }

    const acceptedPairs = [];
    for (let left = 0; left < items.length; left += 1) {
      for (let right = left + 1; right < items.length; right += 1) {
        const similarity = cosine(items[left].vector, items[right].vector);
        if (!(similarity > threshold)) {
          continue;
        }
        if (pairBudget <= 0) {
          break outer;
        }
        pairBudget -= 1;

        if (useJudge) {
          if (!chatUsable(backend)) {
            judgeUnavailable = true;
            break outer;
          }
          const prompt = [
            `You are reviewing two ${type} memories before consolidation.`,
            "",
            `Memory 1: ${items[left].entry.text}`,
            `Memory 2: ${items[right].entry.text}`,
            "",
            "Do they express the same core fact and can they be merged without losing",
            "important information or hiding a conflict?",
            "Reply with YES or NO on the first line.",
          ].join("\n");
          try {
            const response = await backend.chat(prompt, { temperature: 0.1 });
            if (!String(response).trim().startsWith("YES")) {
              continue;
            }
          } catch (error) {
            judgeUnavailable = true;
            warn(logger, "Consolidation LLM judge is unavailable", error);
            break outer;
          }
        }

        acceptedPairs.push({ left, right, similarity });
      }
    }

    if (!judgeUnavailable) {
      const groups = buildMergeGroups(items, acceptedPairs, type);
      mergeGroups.push(...groups);
    }
  }

  if (judgeUnavailable) {
    mergeGroups.length = 0;
    warn(
      logger,
      "Consolidation produced no merge groups because the LLM judge is unavailable",
    );
  }

  mergeGroups.forEach((group, index) => {
    group.group_id = `mg_${index}`;
  });

  const now = new Date();
  const archiveDays = Number.isFinite(config?.maintenance?.archiveDays)
    ? config.maintenance.archiveDays
    : 90;
  const energyThreshold = Number.isFinite(consolidation.energyArchiveThreshold)
    ? consolidation.energyArchiveThreshold
    : 0.5;

  const archiveCandidates = [];
  for (const entry of active) {
    const energy = Number.isFinite(entry.energy) ? entry.energy : initialEnergy(config);
    const lastHit = parseDate(entry.last_hit) || parseDate(entry.timestamp);
    const daysUnhit = lastHit ? Math.max(0, Math.floor((now.getTime() - lastHit.getTime()) / 86400000)) : 0;
    const lowEnergy = energy < energyThreshold;
    const stale = daysUnhit > archiveDays;
    if (!lowEnergy && !stale) {
      continue;
    }
    let archiveReason;
    if (stale && lowEnergy) {
      archiveReason = `${daysUnhit} days without a hit; low energy (${energy.toFixed(2)})`;
    } else if (stale) {
      archiveReason = `${daysUnhit} days without a hit`;
    } else {
      archiveReason = `low energy (${energy.toFixed(2)})`;
    }
    archiveCandidates.push({
      id: entry.id,
      text: typeof entry.text === "string" ? entry.text : "",
      type: entry.type || "general",
      energy,
      days_unhit: daysUnhit,
      reason: archiveReason,
    });
  }

  const skillCandidates = [];
  for (const entry of byType.get("general") || []) {
    const text = typeof entry.text === "string" ? entry.text : "";
    const lower = text.toLowerCase();
    if (SKILL_KEYWORDS.some((keyword) => lower.includes(keyword))) {
      skillCandidates.push({
        id: entry.id,
        text,
        reason: "technical memory; candidate for a skill",
      });
    }
  }

  const proposalId = `prop_${compactLocalTimestamp(now)}_${randomHex(3)}`;
  const byTypeCounts = {};
  for (const [type, entries] of byType) {
    byTypeCounts[type] = entries.length;
  }

  const proposal = {
    proposal_id: proposalId,
    generated_at: localIsoNow(),
    trigger_reason: reason,
    current_stats: {
      active_count: active.length,
      file_size_mb: Math.round(fileSizeMb * 100) / 100,
      by_type: byTypeCounts,
    },
    merge_groups: mergeGroups,
    archive_candidates: archiveCandidates,
    skill_candidates: skillCandidates,
    summary: {
      merge_groups_count: mergeGroups.length,
      archive_candidates_count: archiveCandidates.length,
      skill_candidates_count: skillCandidates.length,
      estimated_reduction: mergeGroups.reduce(
        (total, group) => total + Math.max(0, group.merged_from.length - 1),
        0,
      ),
    },
    status: "pending_review",
  };

  await store.ensureDirs();
  await writeProposal(store, proposal);

  try {
    const home = store.paths.home;
    const state = await loadState({ home });
    await saveState({ ...state, lastProposalAt: proposal.generated_at }, { home });
  } catch (error) {
    warn(logger, "Failed to record lastProposalAt", error);
  }

  return proposal;
}

/**
 * List proposals newest first.
 *
 * @param {import("./store.js").JsonlStore} store Store.
 * @returns {Promise<object[]>} Proposal summaries.
 */
export async function listProposals(store) {
  let entries;
  try {
    entries = await readdir(store.paths.proposalsDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw new HermemoryError("STORE_IO", "Failed to list proposals", {
      status: 500,
      details: { path: store.paths.proposalsDir },
      cause: error,
    });
  }

  const proposals = [];
  for (const dirent of entries) {
    if (!dirent.isFile() || !dirent.name.endsWith(".json")) {
      continue;
    }
    try {
      const text = await readFile(path.join(store.paths.proposalsDir, dirent.name), "utf8");
      const proposal = JSON.parse(text);
      if (!isPlainObject(proposal)) {
        continue;
      }
      const mergeGroups = Array.isArray(proposal.merge_groups) ? proposal.merge_groups : [];
      const archiveCandidates = Array.isArray(proposal.archive_candidates)
        ? proposal.archive_candidates
        : [];
      const skillCandidates = Array.isArray(proposal.skill_candidates)
        ? proposal.skill_candidates
        : [];
      proposals.push({
        proposal_id:
          typeof proposal.proposal_id === "string"
            ? proposal.proposal_id
            : dirent.name.replace(/\.json$/, ""),
        generated_at: proposal.generated_at ?? null,
        status: proposal.status ?? "pending_review",
        trigger_reason: proposal.trigger_reason ?? null,
        counts: {
          merge_groups: mergeGroups.length,
          archive_candidates: archiveCandidates.length,
          skill_candidates: skillCandidates.length,
        },
      });
    } catch {
      // A corrupt proposal must not hide the rest.
    }
  }

  proposals.sort((left, right) => {
    const leftTime = parseDate(left.generated_at);
    const rightTime = parseDate(right.generated_at);
    const leftValue = leftTime ? leftTime.getTime() : 0;
    const rightValue = rightTime ? rightTime.getTime() : 0;
    return rightValue - leftValue || String(right.proposal_id).localeCompare(String(left.proposal_id));
  });
  return proposals;
}

/**
 * Read one proposal.
 *
 * @param {import("./store.js").JsonlStore} store Store.
 * @param {string} id Proposal id.
 * @returns {Promise<object>}
 */
export async function getProposal(store, id) {
  return readProposal(store, id);
}

/**
 * Execute selected merge groups and archive candidates.
 *
 * @param {import("./store.js").JsonlStore} store Store.
 * @param {object} config Configuration.
 * @param {object|null} backend Backend adapter.
 * @param {object} input
 * @param {string} input.id Proposal id.
 * @param {string[]} [input.groups=[]] Selected merge-group ids.
 * @param {string[]} [input.archiveIds=[]] Selected archive candidate ids.
 * @param {object} [input.mergedTexts={}] Edited merged text by group id.
 * @param {AbortSignal} [input.signal] Cancellation signal.
 * @returns {Promise<object>} Execution result.
 */
export async function executeProposal(
  store,
  config,
  backend,
  { id, groups = [], archiveIds = [], mergedTexts = {}, signal } = {},
) {
  const proposal = await readProposal(store, id);
  if (proposal.status !== "pending_review") {
    throw new HermemoryError(
      "INVALID_INPUT",
      `Proposal cannot be executed in status "${proposal.status}": ${proposal.proposal_id}`,
      {
        status: 409,
        details: { id: proposal.proposal_id, status: proposal.status },
      },
    );
  }
  if (!Array.isArray(groups) || !Array.isArray(archiveIds) || !isPlainObject(mergedTexts)) {
    throw new HermemoryError("INVALID_INPUT", "groups/archiveIds must be arrays and mergedTexts an object", {
      status: 400,
      details: { path: "groups|archiveIds|mergedTexts" },
    });
  }

  const proposalGroups = Array.isArray(proposal.merge_groups) ? proposal.merge_groups : [];
  const groupById = new Map();
  for (const group of proposalGroups) {
    if (group && typeof group.group_id === "string") {
      groupById.set(group.group_id, group);
    }
  }

  const warnings = [];
  const selected = [];
  const seenGroups = new Set();
  for (const groupId of groups) {
    if (seenGroups.has(groupId)) {
      continue;
    }
    seenGroups.add(groupId);
    const group = groupById.get(groupId);
    if (!group) {
      warnings.push(`Unknown merge group skipped: ${groupId}`);
      continue;
    }
    const memberIds = Array.isArray(group.merged_from)
      ? group.merged_from.filter((memberId) => typeof memberId === "string")
      : [];
    const proposalMembers = Array.isArray(group.memories) ? group.memories : [];
    const edited =
      typeof mergedTexts[groupId] === "string" ? mergedTexts[groupId].trim() : "";
    const text =
      edited ||
      (typeof group.proposed_text === "string" ? group.proposed_text.trim() : "") ||
      longestText(proposalMembers).trim();
    if (!text) {
      warnings.push(`Merge group skipped because it has no text: ${groupId}`);
      continue;
    }

    let embedding = null;
    if (embedUsable(backend)) {
      try {
        const vector = await backend.embed(text, { signal });
        if (validVector(vector)) {
          embedding = vector;
        }
      } catch (error) {
        warnings.push(`Embedding failed for merge group ${groupId}: ${shortMessage(error)}`);
      }
    }
    selected.push({ group, memberIds, text, embedding });
  }

  const candidateArchiveIds = new Set(
    (Array.isArray(proposal.archive_candidates) ? proposal.archive_candidates : [])
      .map((candidate) => candidate?.id)
      .filter((candidateId) => typeof candidateId === "string"),
  );
  const selectedArchiveIds = [];
  const seenArchiveIds = new Set();
  for (const archiveId of archiveIds) {
    if (seenArchiveIds.has(archiveId)) {
      continue;
    }
    seenArchiveIds.add(archiveId);
    if (!candidateArchiveIds.has(archiveId)) {
      warnings.push(`Archive candidate skipped because it is not in this proposal: ${archiveId}`);
      continue;
    }
    selectedArchiveIds.push(archiveId);
  }

  if (selected.length === 0 && selectedArchiveIds.length === 0) {
    throw new HermemoryError(
      "INVALID_INPUT",
      "No valid merge groups or archive candidates were selected",
      {
        status: 400,
        details: { id: proposal.proposal_id, groups, archiveIds },
      },
    );
  }

  const snapshot = await store.snapshot(`execute proposal ${proposal.proposal_id}`);
  const backupPath = snapshot.backupPath;
  let mergedCount = 0;
  let archivedCount = 0;

  await store.transaction(async (tx) => {
    const active = await tx.loadActive({ includeArchived: true });
    const archived = await tx.loadArchive();
    const knownIds = new Set();
    for (const entry of [...active, ...archived]) {
      if (entry && typeof entry.id === "string") {
        knownIds.add(entry.id);
      }
    }
    const generateId = () => {
      let candidate = newMemoryId();
      while (knownIds.has(candidate)) {
        candidate = newMemoryId();
      }
      knownIds.add(candidate);
      return candidate;
    };

    for (const selection of selected) {
      const { group } = selection;
      const memberIds = new Set(selection.memberIds);
      const members = active.filter(
        (entry) => entry.archived !== true && memberIds.has(entry.id),
      );
      if (members.length < 2) {
        warnings.push(
          `Merge group skipped because fewer than two members are still active: ${group.group_id}`,
        );
        continue;
      }

      const now = localIsoNow();
      const newId = generateId();
      const maxEnergy = members.reduce(
        (maximum, entry) =>
          Math.max(maximum, Number.isFinite(entry.energy) ? entry.energy : initialEnergy(config)),
        initialEnergy(config),
      );
      const category =
        (members[0] && typeof members[0].category === "string" && members[0].category) ||
        "general";

      const entry = {
        id: newId,
        text: selection.text,
        type: typeof group.type === "string" && group.type ? group.type : "general",
        category,
        timestamp: now,
        archived: false,
        energy: maxEnergy + 1,
        last_hit: now,
        merged_from: selection.memberIds,
        merge_date: now,
        merge_proposal: proposal.proposal_id,
        origin: { source: "consolidation" },
      };
      if (selection.embedding) {
        entry.embedding = selection.embedding;
      }

      for (let index = active.length - 1; index >= 0; index -= 1) {
        const member = active[index];
        if (member.archived === true || !memberIds.has(member.id)) {
          continue;
        }
        member.archived = true;
        member.merged_into = newId;
        member.merge_date = now;
        member.merge_proposal = proposal.proposal_id;
        member.archive_date = now;
        member.archive_reason = `merged:${proposal.proposal_id}`;
        archived.push(member);
        active.splice(index, 1);
      }
      active.push(entry);
      mergedCount += 1;
    }

    for (const archiveId of selectedArchiveIds) {
      const index = active.findIndex((entry) => entry.id === archiveId);
      if (index < 0) {
        warnings.push(`Archive candidate skipped because it is not active: ${archiveId}`);
        continue;
      }
      const entry = active[index];
      entry.archived = true;
      entry.archive_date = localIsoNow();
      entry.archive_reason = `archived by proposal ${proposal.proposal_id}`;
      archived.push(entry);
      active.splice(index, 1);
      archivedCount += 1;
    }

    await tx.writeActive(active);
    await tx.writeArchive(archived);
    await writeStamp(store);
  });

  proposal.status = "executed";
  proposal.executed_at = localIsoNow();
  proposal.results = {
    merged_count: mergedCount,
    archived_count: archivedCount,
    backup_path: backupPath,
  };
  await writeProposal(store, proposal);

  return {
    proposal_id: proposal.proposal_id,
    status: "executed",
    merged_count: mergedCount,
    archived_count: archivedCount,
    backup_path: backupPath,
    warnings,
  };
}

/**
 * Restore the store from the snapshot an executed proposal took.
 *
 * @param {import("./store.js").JsonlStore} store Store.
 * @param {object} config Configuration.
 * @param {string} id Proposal id.
 * @returns {Promise<object>} Restore result.
 */
export async function restoreProposal(store, config, id) {
  const proposal = await readProposal(store, id);
  if (proposal.status !== "executed") {
    throw new HermemoryError(
      "PROPOSAL_NOT_EXECUTED",
      `Proposal has not been executed: ${proposal.proposal_id}`,
      { status: 409, details: { id: proposal.proposal_id, status: proposal.status } },
    );
  }

  const backupPath = proposal.results?.backup_path;
  if (typeof backupPath !== "string" || !backupPath) {
    throw new HermemoryError("SNAPSHOT_NOT_FOUND", "Proposal has no snapshot path", {
      status: 404,
      details: { id: proposal.proposal_id },
    });
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(backupPath, "utf8"));
  } catch (error) {
    throw new HermemoryError("SNAPSHOT_NOT_FOUND", `Snapshot not found: ${backupPath}`, {
      status: 404,
      details: { id: proposal.proposal_id, path: backupPath },
      cause: error,
    });
  }
  if (!isPlainObject(manifest) || !Array.isArray(manifest.files)) {
    throw new HermemoryError("SNAPSHOT_NOT_FOUND", "Snapshot manifest is invalid", {
      status: 404,
      details: { id: proposal.proposal_id, path: backupPath },
    });
  }

  let activeText = "";
  let archiveText = "";
  let activeFound = false;
  let archiveFound = false;

  for (const file of manifest.files) {
    if (typeof file !== "string") {
      continue;
    }
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      throw new HermemoryError("SNAPSHOT_NOT_FOUND", `Snapshot file not found: ${file}`, {
        status: 404,
        details: { id: proposal.proposal_id, path: file },
        cause: error,
      });
    }
    const base = path.basename(file);
    if (base.includes("semantic_memories")) {
      activeText = text;
      activeFound = true;
    } else if (base.includes("archived_memories")) {
      archiveText = text;
      archiveFound = true;
    }
  }

  if (!activeFound && !archiveFound) {
    throw new HermemoryError("SNAPSHOT_NOT_FOUND", "Snapshot contains no store files", {
      status: 404,
      details: { id: proposal.proposal_id, path: backupPath },
    });
  }

  const activeEntries = parseJsonl(activeText);
  const archiveEntries = parseJsonl(archiveText);

  await store.withLock(async () => {
    await store.writeActive(activeEntries);
    await store.writeArchive(archiveEntries);
    await writeStamp(store);
  });

  proposal.status = "restored";
  proposal.restored_at = localIsoNow();
  await writeProposal(store, proposal);

  return {
    restored: true,
    proposal_id: proposal.proposal_id,
    active: activeEntries.length,
    archived: archiveEntries.length,
  };
}
