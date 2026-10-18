/**
 * Hybrid retrieval: CJK-aware tokenization, BM25, dense cosine ranking, and
 * Reciprocal Rank Fusion.
 *
 * The kernel follows her.memory's retrieval semantics:
 * stable-key hits come first, dense scores are weighted by lifecycle energy,
 * and only positive BM25 scores participate in the sparse ranking.
 *
 * @module retrieval
 */

import { cosine, isPlainObject } from "./util.js";

/** CJK-aware tokenizer: words for Latin text, single characters for CJK. */
const TOKEN_RE = /[a-zA-Z0-9_]+|[\u4e00-\u9fff]/g;

/** Stable-key shape used in query text, e.g. `[topic_subtopic]`. */
const STABLE_KEY_RE = /(\[[^\]\[]{2,40}\])/;

/**
 * Tokenize text for BM25.
 *
 * English words and numbers stay whole (`9880`, `SoVITS`); Chinese characters
 * are indexed one by one, which is sufficient at companion-memory scale.
 *
 * @param {string} text Text to tokenize.
 * @returns {string[]} Lowercased tokens in source order.
 */
export function tokenize(text) {
  if (typeof text !== "string" || !text) {
    return [];
  }
  return (text.toLowerCase().match(TOKEN_RE) || []).map((token) => token);
}

/**
 * Minimal in-memory BM25 index.
 */
export class BM25Index {
  /**
   * @param {string[]} docs Document texts.
   * @param {object} [options]
   * @param {number} [options.k1=1.5] Term-frequency saturation.
   * @param {number} [options.b=0.75] Length-normalization strength.
   */
  constructor(docs, { k1 = 1.5, b = 0.75 } = {}) {
    const texts = Array.isArray(docs) ? docs : [];
    this.k1 = k1;
    this.b = b;
    this.docTokens = texts.map((doc) => tokenize(typeof doc === "string" ? doc : ""));
    this.docLen = this.docTokens.map((tokens) => tokens.length);
    this.N = texts.length;
    this.avgdl =
      this.docLen.length > 0
        ? this.docLen.reduce((sum, length) => sum + length, 0) / this.docLen.length
        : 0;
    this.df = new Map();
    for (const tokens of this.docTokens) {
      for (const term of new Set(tokens)) {
        this.df.set(term, (this.df.get(term) || 0) + 1);
      }
    }
  }

  /**
   * Inverse document frequency for a term; 0 when the term is unseen.
   *
   * @param {string} term Token.
   * @returns {number}
   */
  idf(term) {
    const frequency = this.df.get(term) || 0;
    if (frequency === 0 || this.N === 0) {
      return 0;
    }
    return Math.log((this.N - frequency + 0.5) / (frequency + 0.5) + 1);
  }

  /**
   * Score one document against a query.
   *
   * @param {string} query Query text.
   * @param {number} index Document index.
   * @returns {number} BM25 score.
   */
  score(query, index) {
    const tokens = this.docTokens[index];
    const length = this.docLen[index];
    if (!tokens || !length) {
      return 0;
    }

    const termFrequency = new Map();
    for (const token of tokens) {
      termFrequency.set(token, (termFrequency.get(token) || 0) + 1);
    }

    let total = 0;
    for (const term of new Set(tokenize(query))) {
      const frequency = termFrequency.get(term) || 0;
      if (frequency === 0) {
        continue;
      }
      const idf = this.idf(term);
      const denominator =
        frequency +
        this.k1 * (1 - this.b + this.b * (length / (this.avgdl || 1)));
      total += (idf * frequency * (this.k1 + 1)) / denominator;
    }
    return total;
  }

  /**
   * Score every document against a query.
   *
   * @param {string} query Query text.
   * @returns {number[]} Scores aligned with the document array.
   */
  scores(query) {
    return this.docTokens.map((_, index) => this.score(query, index));
  }
}

/**
 * Fuse two ranked index lists with Reciprocal Rank Fusion.
 *
 * RRF scores are `1 / (k + rank + 1)`; ties are broken by index ascending so
 * results are deterministic.
 *
 * @param {number[]} denseRanked Dense ranking (best first).
 * @param {number[]} sparseRanked Sparse ranking (best first).
 * @param {number} topK Maximum results.
 * @param {number} [k=60] RRF constant.
 * @returns {number[]} Fused indexes.
 */
export function rrfFuse(denseRanked, sparseRanked, topK, k = 60) {
  const scores = new Map();
  const add = (ranked) => {
    if (!Array.isArray(ranked)) return;
    ranked.forEach((index, rank) => {
      if (!Number.isInteger(index)) return;
      scores.set(index, (scores.get(index) || 0) + 1 / (k + rank + 1));
    });
  };
  add(denseRanked);
  add(sparseRanked);

  const ordered = [...scores.keys()].sort(
    (left, right) => scores.get(right) - scores.get(left) || left - right,
  );
  const limit = Number.isInteger(topK) ? Math.max(0, topK) : ordered.length;
  return ordered.slice(0, limit);
}

/**
 * Rank documents by BM25 + dense cosine, fused with RRF.
 *
 * @param {string} query Query text.
 * @param {string[]} docs Document texts.
 * @param {number[]} denseScores Dense scores aligned with `docs`. Values below
 *   `minDense` (including `-Infinity` for missing embeddings) are excluded.
 * @param {number} topK Maximum results.
 * @param {number} [minDense=0] Minimum dense score.
 * @param {number} [k=60] RRF constant.
 * @returns {number[]} Document indexes, best first.
 */
export function hybridRank(query, docs, denseScores, topK, minDense = 0, k = 60) {
  const texts = Array.isArray(docs) ? docs : [];
  if (texts.length === 0) {
    return [];
  }

  const dense = Array.isArray(denseScores) ? denseScores : [];
  const n = dense.length > 0 ? Math.min(texts.length, dense.length) : texts.length;

  const denseOrder = [];
  for (let index = 0; index < n; index += 1) {
    const score = dense[index];
    if (typeof score === "number" && Number.isFinite(score) && score >= minDense) {
      denseOrder.push(index);
    }
  }
  denseOrder.sort((left, right) => dense[right] - dense[left] || left - right);

  const index = new BM25Index(texts.slice(0, n));
  const sparseScores = index.scores(query);
  const sparseOrder = [];
  for (let position = 0; position < sparseScores.length; position += 1) {
    if (sparseScores[position] > 0) {
      sparseOrder.push(position);
    }
  }
  sparseOrder.sort(
    (left, right) => sparseScores[right] - sparseScores[left] || left - right,
  );

  return rrfFuse(denseOrder, sparseOrder, topK, k);
}

/** Round without producing `-0`. */
function round(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Valid embedding check: non-empty array of finite numbers. */
function isValidEmbedding(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

/** Search one candidate set and return the public result envelope. */
function makeItem(entry, { similarity, bm25, rrf }) {
  const energy = Number.isFinite(entry.energy) ? entry.energy : 2.0;
  return {
    id: typeof entry.id === "string" ? entry.id : "",
    text: typeof entry.text === "string" ? entry.text : "",
    type: typeof entry.type === "string" && entry.type ? entry.type : "general",
    category:
      typeof entry.category === "string" && entry.category ? entry.category : "general",
    timestamp: entry.timestamp ?? null,
    event_date: entry.event_date ?? null,
    project_key: entry.project_key ?? null,
    stable_key: entry.stable_key ?? null,
    archived: entry.archived === true || entry._archived === true,
    energy,
    last_hit: entry.last_hit ?? null,
    similarity: round(similarity, 3),
    bm25: round(bm25, 4),
    rrf: rrf === null || rrf === undefined ? null : round(rrf, 6),
    retrievalMode: similarity === null || similarity === undefined ? "keyword" : "hybrid",
  };
}

/**
 * Hybrid search over already-filtered memory entries.
 *
 * The caller owns category/type filtering and hit logging. Archived entries
 * are excluded unless `includeArchived` is true.
 *
 * @param {object} params
 * @param {object[]} [params.entries=[]] Candidate entries.
 * @param {string} [params.query=""] Query text.
 * @param {number} [params.topK=8] Maximum results.
 * @param {number} [params.minSimilarity=0] Minimum dense score (pre-weight).
 * @param {number} [params.rrfK=60] RRF constant.
 * @param {object|null} [params.backend=null] Embedding backend.
 * @param {number} [params.energyMax=5] Energy normalization ceiling.
 * @param {boolean} [params.includeArchived=false] Include archived entries.
 * @param {AbortSignal} [params.signal] Cancellation signal.
 * @returns {Promise<{query: string, retrievalMode: string, results: object[], warnings: string[]}>}
 */
export async function searchMemories({
  entries = [],
  query = "",
  topK = 8,
  minSimilarity = 0,
  rrfK = 60,
  backend = null,
  energyMax = 5,
  includeArchived = false,
  signal,
} = {}) {
  const warnings = [];
  const queryText = typeof query === "string" ? query : "";
  const effectiveTopK = Math.max(0, Math.floor(Number(topK) || 0));
  const effectiveK = Number.isFinite(rrfK) && rrfK > 0 ? rrfK : 60;
  const minimumDense = Number.isFinite(minSimilarity) ? minSimilarity : 0;
  const maxEnergy = Number.isFinite(energyMax) && energyMax > 0 ? energyMax : 5;

  const candidates = (Array.isArray(entries) ? entries : [])
    .filter((entry) => isPlainObject(entry))
    .filter((entry) => includeArchived || (entry.archived !== true && entry._archived !== true));

  if (!queryText.trim() || effectiveTopK === 0 || candidates.length === 0) {
    return { query: queryText, retrievalMode: "empty", results: [], warnings };
  }

  const keyMatch = STABLE_KEY_RE.exec(queryText);
  const keyIndexes = new Set();
  if (keyMatch) {
    const wantedKey = keyMatch[1];
    candidates.forEach((entry, index) => {
      if (
        entry.stable_key === wantedKey ||
        (typeof entry.text === "string" && entry.text.startsWith(wantedKey))
      ) {
        keyIndexes.add(index);
      }
    });
  }

  const index = new BM25Index(candidates.map((entry) => entry.text));
  const bm25Scores = index.scores(queryText);

  let queryEmbedding = null;
  const backendKind = backend && typeof backend.kind === "string" ? backend.kind : "none";
  if (backend && backendKind !== "none" && typeof backend.embed === "function" && candidates.length > 0) {
    try {
      const embedding = await backend.embed(queryText, { signal });
      if (isValidEmbedding(embedding)) {
        queryEmbedding = embedding;
      } else {
        warnings.push("Embedding backend returned an invalid vector; using keyword retrieval");
      }
    } catch (error) {
      warnings.push(
        `Embedding backend unavailable; using keyword retrieval (${error?.message || error})`,
      );
    }
  }

  const rawSimilarities = new Array(candidates.length).fill(null);
  const denseScores = new Array(candidates.length).fill(Number.NEGATIVE_INFINITY);
  let denseAvailable = false;
  let missingEmbeddings = 0;

  if (queryEmbedding) {
    candidates.forEach((entry, candidateIndex) => {
      const embedding = entry.embedding;
      if (!isValidEmbedding(embedding) || embedding.length !== queryEmbedding.length) {
        missingEmbeddings += 1;
        return;
      }
      const similarity = cosine(queryEmbedding, embedding);
      const energy = Number.isFinite(entry.energy) ? entry.energy : 2.0;
      const weight = 0.5 + (0.5 * Math.min(energy, maxEnergy)) / maxEnergy;
      rawSimilarities[candidateIndex] = similarity;
      denseScores[candidateIndex] = similarity * weight;
      denseAvailable = true;
    });

    if (missingEmbeddings > 0) {
      warnings.push(
        `Skipped dense ranking for ${missingEmbeddings} memories with missing or incompatible embeddings`,
      );
    }
  }

  const restPositions = candidates
    .map((_, indexValue) => indexValue)
    .filter((indexValue) => !keyIndexes.has(indexValue));

  const restDense = restPositions.map((indexValue) => denseScores[indexValue]);
  const restBm25 = restPositions.map((indexValue) => bm25Scores[indexValue]);

  const denseOrder = [];
  for (let position = 0; position < restPositions.length; position += 1) {
    const score = restDense[position];
    if (Number.isFinite(score) && score >= minimumDense) {
      denseOrder.push(position);
    }
  }
  denseOrder.sort(
    (left, right) => restDense[right] - restDense[left] || left - right,
  );

  const sparseOrder = [];
  for (let position = 0; position < restBm25.length; position += 1) {
    if (restBm25[position] > 0) {
      sparseOrder.push(position);
    }
  }
  sparseOrder.sort(
    (left, right) => restBm25[right] - restBm25[left] || left - right,
  );

  const rrfScores = new Map();
  const addRrf = (order) => {
    order.forEach((position, rank) => {
      rrfScores.set(position, (rrfScores.get(position) || 0) + 1 / (effectiveK + rank + 1));
    });
  };
  addRrf(denseOrder);
  addRrf(sparseOrder);

  const rankedPositions = rrfFuse(denseOrder, sparseOrder, effectiveTopK, effectiveK);

  const results = [];
  for (const candidateIndex of keyIndexes) {
    const entry = candidates[candidateIndex];
    results.push(
      makeItem(entry, {
        similarity: rawSimilarities[candidateIndex],
        bm25: bm25Scores[candidateIndex],
        rrf: null,
      }),
    );
  }

  for (const position of rankedPositions) {
    if (results.length >= effectiveTopK) {
      break;
    }
    const candidateIndex = restPositions[position];
    const entry = candidates[candidateIndex];
    results.push(
      makeItem(entry, {
        similarity: rawSimilarities[candidateIndex],
        bm25: bm25Scores[candidateIndex],
        rrf: rrfScores.get(position) ?? null,
      }),
    );
  }

  results.length = Math.min(results.length, effectiveTopK);

  if (results.length === 0) {
    return { query: queryText, retrievalMode: "empty", results, warnings };
  }

  const hybridUsed =
    (denseAvailable && (denseOrder.length > 0 || [...keyIndexes].some((i) => rawSimilarities[i] !== null))) ||
    results.some((item) => item.similarity !== null);

  return {
    query: queryText,
    retrievalMode: hybridUsed ? "hybrid" : "keyword",
    results,
    warnings,
  };
}
