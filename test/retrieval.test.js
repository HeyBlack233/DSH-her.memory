import test from "node:test";
import assert from "node:assert/strict";

import {
  BM25Index,
  hybridRank,
  rrfFuse,
  searchMemories,
  tokenize,
} from "../lib/retrieval.js";
import { makeEntry } from "./helpers.js";

/** Backend stub that returns a fixed query vector. */
function embeddingBackend(vector) {
  return {
    kind: "ollama",
    embed: async () => vector,
    chat: async () => "YES",
  };
}

/** Backend stub that fails like an unreachable server. */
function failingBackend() {
  return {
    kind: "ollama",
    embed: async () => {
      throw new Error("connection refused");
    },
    chat: async () => "YES",
  };
}

test("tokenize keeps Latin words and splits CJK per character", () => {
  assert.deepEqual(tokenize("Node22 端口 9880 Error"), [
    "node22",
    "端",
    "口",
    "9880",
    "error",
  ]);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize(null), []);
});

test("BM25 scores matching docs and ignores unseen terms", () => {
  const index = new BM25Index(["alpha beta", "gamma", "alpha"]);
  assert.ok(index.idf("alpha") > 0);
  assert.equal(index.idf("missing"), 0);
  assert.ok(index.score("alpha", 0) > 0);
  assert.ok(index.score("alpha", 2) > 0);
  assert.equal(index.score("gamma", 0), 0);
  assert.equal(index.scores("alpha").length, 3);
  assert.equal(index.avgdl > 0, true);
});

test("BM25 returns zero for empty text and empty queries", () => {
  const index = new BM25Index(["", "one"]);
  assert.equal(index.score("one", 0), 0);
  assert.equal(index.score("", 1), 0);
});

test("rrfFuse fuses ranks and breaks ties by index ascending", () => {
  assert.deepEqual(rrfFuse([0, 1], [1, 2], 3, 60), [1, 0, 2]);
  assert.deepEqual(rrfFuse([0, 1], [1, 0], 2, 60), [0, 1]);
  assert.deepEqual(rrfFuse([], [], 5, 60), []);
  assert.deepEqual(rrfFuse([0], [0], 1, 60), [0]);
});

test("hybridRank performs dense, sparse, and fused ranking", () => {
  const docs = ["apple banana", "banana", "carrot"];
  const ranked = hybridRank("banana", docs, [0.1, 0.9, 0.2], 2, 0);
  assert.deepEqual(ranked, [1, 0]);

  const sparseOnly = hybridRank("banana", docs, [], 3, 0);
  assert.deepEqual(sparseOnly, [1, 0]);

  const denseOnly = hybridRank("zzz", docs, [0.3, 0.9, 0.1], 2, 0);
  assert.deepEqual(denseOnly, [1, 0]);

  const filtered = hybridRank("zzz", docs, [0.1, 0.9, 0.2], 3, 0.5);
  assert.deepEqual(filtered, [1]);

  assert.deepEqual(hybridRank("anything", [], [], 3), []);
});

test("keyword-only search returns BM25 results without embeddings", async () => {
  const entries = [
    makeEntry({ id: "a", text: "User prefers jasmine tea in the evening" }),
    makeEntry({ id: "b", text: "The nightly python job failed" }),
    makeEntry({ id: "c", text: "Old jasmine tea note", archived: true }),
  ];

  const result = await searchMemories({
    entries,
    query: "jasmine tea",
    topK: 5,
    backend: { kind: "none" },
  });

  assert.equal(result.retrievalMode, "keyword");
  assert.equal(result.results[0].id, "a");
  assert.equal(result.results[0].retrievalMode, "keyword");
  assert.equal(result.results[0].similarity, null);
  assert.ok(result.results[0].bm25 > 0);
  assert.ok(!result.results.some((item) => item.id === "c"));
  assert.deepEqual(result.warnings, []);

  const withArchived = await searchMemories({
    entries,
    query: "jasmine tea",
    topK: 5,
    backend: { kind: "none" },
    includeArchived: true,
  });
  assert.ok(withArchived.results.some((item) => item.id === "c"));
});

test("hybrid search combines dense and sparse rankings", async () => {
  const entries = [
    makeEntry({ id: "dense", text: "completely unrelated words", embedding: [1, 0] }),
    makeEntry({ id: "sparse", text: "jasmine tea", embedding: [0, 1] }),
  ];

  const result = await searchMemories({
    entries,
    query: "jasmine tea",
    topK: 5,
    backend: embeddingBackend([1, 0]),
  });

  assert.equal(result.retrievalMode, "hybrid");
  assert.equal(result.results[0].id, "sparse");
  assert.equal(result.results.length, 2);
  assert.notEqual(result.results[0].similarity, null);
  assert.notEqual(result.results[1].similarity, null);
  assert.equal(result.results[0].retrievalMode, "hybrid");
});

test("an embedding failure degrades to keyword mode with a warning", async () => {
  const entries = [makeEntry({ id: "a", text: "jasmine tea" })];
  const result = await searchMemories({
    entries,
    query: "jasmine tea",
    backend: failingBackend(),
  });

  assert.equal(result.retrievalMode, "keyword");
  assert.equal(result.results[0].id, "a");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Embedding backend unavailable/);
});

test("stable-key hits are returned before hybrid results", async () => {
  const entries = [
    makeEntry({
      id: "other",
      text: "[topic_x] appears in unrelated prose",
      stable_key: "[topic_x]",
    }),
    makeEntry({ id: "key2", text: "[topic_x] second keyed note", stable_key: "[topic_x]" }),
    makeEntry({ id: "plain", text: "topic_x note with many matching words" }),
  ];

  const result = await searchMemories({
    entries,
    query: "[topic_x]",
    topK: 3,
    backend: { kind: "none" },
  });

  assert.deepEqual(result.results.map((item) => item.id), ["other", "key2", "plain"]);
});

test("stable-key hits are deduplicated and fill up to topK", async () => {
  const entries = [
    makeEntry({ id: "key1", text: "[topic_y] one", stable_key: "[topic_y]" }),
    makeEntry({ id: "key2", text: "[topic_y] two", stable_key: "[topic_y]" }),
    makeEntry({ id: "rest", text: "topic y unrelated" }),
  ];
  const result = await searchMemories({
    entries,
    query: "[topic_y]",
    topK: 2,
    backend: { kind: "none" },
  });
  assert.deepEqual(result.results.map((item) => item.id), ["key1", "key2"]);
  assert.equal(new Set(result.results.map((item) => item.id)).size, 2);
});

test("energy weights dense scores", async () => {
  const entries = [
    makeEntry({ id: "low", text: "nothing here", embedding: [1, 0], energy: 0.5 }),
    makeEntry({ id: "high", text: "nothing here", embedding: [1, 0], energy: 5 }),
  ];

  const result = await searchMemories({
    entries,
    query: "zzz",
    topK: 2,
    backend: embeddingBackend([1, 0]),
    energyMax: 5,
  });

  assert.equal(result.retrievalMode, "hybrid");
  assert.deepEqual(result.results.map((item) => item.id), ["high", "low"]);
  assert.equal(result.results[0].similarity, 1);
});

test("missing and incompatible embeddings are counted in warnings", async () => {
  const entries = [
    makeEntry({ id: "ok", text: "one", embedding: [1, 0] }),
    makeEntry({ id: "missing", text: "two" }),
    makeEntry({ id: "wrong-length", text: "three", embedding: [1, 0, 0] }),
  ];

  const result = await searchMemories({
    entries,
    query: "zzz",
    topK: 5,
    backend: embeddingBackend([1, 0]),
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].id, "ok");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /2 memories/);
});

test("minSimilarity filters dense-only candidates", async () => {
  const entries = [makeEntry({ id: "low", text: "nothing", embedding: [0, 1] })];
  const result = await searchMemories({
    entries,
    query: "zzz",
    topK: 5,
    backend: embeddingBackend([1, 0]),
    minSimilarity: 0.5,
  });
  assert.equal(result.retrievalMode, "empty");
  assert.deepEqual(result.results, []);
});

test("empty queries and empty candidate sets return an empty envelope", async () => {
  const emptyQuery = await searchMemories({ entries: [makeEntry()], query: "   " });
  assert.equal(emptyQuery.retrievalMode, "empty");
  assert.deepEqual(emptyQuery.results, []);

  const emptyEntries = await searchMemories({ entries: [], query: "tea" });
  assert.equal(emptyEntries.retrievalMode, "empty");
});
