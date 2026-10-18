import test from "node:test";
import assert from "node:assert/strict";

import { MEMORY_TOOL_NAMES, registerTools } from "../lib/tools.js";

/** Build a fake context and engine, then run the real registration path. */
function createHarness(implementations = {}) {
  const definitions = [];
  const calls = [];
  const engine = {};
  for (const method of ["search", "add", "update", "archive"]) {
    engine[method] = async (args) => {
      calls.push({ method, args });
      const implementation = implementations[method];
      return typeof implementation === "function" ? implementation(args) : implementation;
    };
  }
  const ctx = {
    tools: {
      register(definition) {
        definitions.push(definition);
        return () => {};
      }
    },
    effect(callback) {
      return callback();
    }
  };
  registerTools(ctx, engine);
  const byName = Object.fromEntries(definitions.map((definition) => [definition.name, definition]));
  return { definitions, byName, calls, engine };
}

/** A tool run context carrying provenance and cancellation. */
function createExec(overrides = {}) {
  return {
    signal: new AbortController().signal,
    callId: "call_1",
    agent: { id: "session_1" },
    ...overrides
  };
}

/** The text of the first rendered content block. */
function renderedText(definition, args, value) {
  const blocks = definition.output.render(args, value);
  assert.equal(Array.isArray(blocks), true);
  assert.equal(blocks[0].type, "text");
  return blocks[0].text;
}

test("registers four global tools with raw JSON Schemas", () => {
  const { definitions, byName } = createHarness();

  assert.equal(definitions.length, 4);
  assert.deepEqual(definitions.map((definition) => definition.name), [...MEMORY_TOOL_NAMES]);

  for (const definition of definitions) {
    assert.equal(definition.parameters.type, "object");
    assert.equal(definition.parameters.additionalProperties, false);
    assert.equal(Array.isArray(definition.parameters.required), true);
    assert.equal(typeof definition.output.render, "function");
    assert.equal(definition.output.schema.type, "object");
    assert.equal(definition.output.schema.additionalProperties, false);
    assert.equal(Array.isArray(definition.output.schema.required), true);
    for (const [propertyName, property] of Object.entries(definition.parameters.properties)) {
      assert.equal(typeof property.type, "string", `${definition.name}.${propertyName} needs a type`);
      assert.equal(typeof property.description, "string", `${definition.name}.${propertyName} needs a description`);
      assert.equal(
        Object.hasOwn(property, "required"),
        false,
        `${definition.name}.${propertyName} must use the top-level required array`
      );
    }
  }

  assert.deepEqual(byName.memory_search.parameters.required, ["query"]);
  assert.equal(byName.memory_search.parameters.properties.topK.type, "integer");
  assert.equal(byName.memory_search.parameters.properties.topK.minimum, 1);
  assert.equal(byName.memory_search.parameters.properties.topK.maximum, 20);
  assert.deepEqual(byName.memory_search.parameters.properties.type.enum, [
    "general",
    "event",
    "preference",
    "emotional"
  ]);
  assert.deepEqual(byName.memory_search.parameters.properties.includeArchived.type, "boolean");

  assert.deepEqual(byName.memory_add.parameters.required, ["text"]);
  assert.deepEqual(byName.memory_update.parameters.required, ["id"]);
  assert.deepEqual(byName.memory_archive.parameters.required, ["id"]);
});

test("memory_search forwards filters and renders the result list", async () => {
  const { byName, calls } = createHarness({
    search: () => ({
      query: "tea",
      retrievalMode: "hybrid",
      results: [
        {
          id: "mem_1",
          text: "Likes jasmine tea",
          type: "preference",
          category: "food",
          similarity: 0.87,
          energy: 0.6,
          recorded: "2026-01-02T03:04:05.000Z"
        }
      ],
      warnings: ["embedding backend offline"]
    })
  });

  const exec = createExec();
  const args = { query: "tea", topK: 3, category: "food", type: "preference", includeArchived: true };
  const value = await byName.memory_search.execute(args, exec);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "search");
  assert.deepEqual(calls[0].args, { ...args, signal: exec.signal });
  assert.deepEqual(value, {
    query: "tea",
    retrievalMode: "hybrid",
    results: [
      {
        id: "mem_1",
        text: "Likes jasmine tea",
        type: "preference",
        category: "food",
        similarity: 0.87,
        energy: 0.6,
        recorded: "2026-01-02T03:04:05.000Z"
      }
    ],
    warnings: ["embedding backend offline"]
  });

  const text = renderedText(byName.memory_search, args, value);
  assert.match(text, /Found 1 memory for "tea" \(hybrid\)\./);
  assert.match(text, /mem_1 \[preference\/food\] Likes jasmine tea/);
  assert.match(text, /similarity 0\.870 \| energy 0\.60 \| recorded 2026-01-02T03:04:05\.000Z/);
  assert.match(text, /Warning: embedding backend offline/);
});

test("memory_search explains an empty keyword-only result", async () => {
  const { byName } = createHarness({
    search: () => ({ query: "nothing", retrievalMode: "keyword", results: [], warnings: [] })
  });

  const args = { query: "nothing" };
  const value = await byName.memory_search.execute(args, createExec());
  const text = renderedText(byName.memory_search, args, value);

  assert.match(text, /No memories matched "nothing"\./);
  assert.match(text, /keyword matching only/);
});

test("memory_add passes tool provenance and renders stored and duplicate outcomes", async () => {
  const { byName, calls } = createHarness({
    add: () => ({ added: true, id: "mem_2", duplicateId: null, hasEmbedding: true, warnings: [] })
  });

  const exec = createExec();
  const args = {
    text: "Likes jasmine tea",
    type: "preference",
    category: "food",
    eventDate: "2026-01-01",
    projectKey: "dsh-her-memory",
    dedupe: true
  };
  const value = await byName.memory_add.execute(args, exec);

  assert.equal(calls[0].method, "add");
  assert.deepEqual(calls[0].args, {
    ...args,
    origin: { sessionId: "session_1", toolCallId: "call_1", source: "tool" },
    signal: exec.signal
  });
  assert.deepEqual(value, {
    added: true,
    id: "mem_2",
    duplicateId: null,
    hasEmbedding: true,
    warnings: []
  });
  assert.match(renderedText(byName.memory_add, args, value), /Stored memory mem_2 \(preference\/food\)\./);

  const duplicate = {
    added: false,
    id: null,
    duplicateId: "mem_9",
    hasEmbedding: true,
    warnings: []
  };
  assert.match(
    renderedText(byName.memory_add, args, duplicate),
    /Skipped duplicate; an equivalent memory already exists as mem_9\./
  );
});

test("memory_update passes provenance and renders the superseding id", async () => {
  const { byName, calls } = createHarness({
    update: () => ({ updated: true, oldId: "mem_2", newId: "mem_3", hasEmbedding: false })
  });

  const exec = createExec();
  const args = { id: "mem_2", text: "Prefers green tea" };
  const value = await byName.memory_update.execute(args, exec);

  assert.equal(calls[0].method, "update");
  assert.deepEqual(calls[0].args, {
    id: "mem_2",
    text: "Prefers green tea",
    type: undefined,
    category: undefined,
    eventDate: undefined,
    origin: { sessionId: "session_1", toolCallId: "call_1", source: "tool" },
    signal: exec.signal
  });
  assert.deepEqual(value, { updated: true, oldId: "mem_2", newId: "mem_3", hasEmbedding: false });

  const text = renderedText(byName.memory_update, args, value);
  assert.match(text, /Updated memory mem_2; it now has id mem_3\./);
  assert.match(text, /No embedding is available/);
});

test("memory_archive passes provenance and renders archived and already-archived outcomes", async () => {
  const { byName, calls } = createHarness({
    archive: () => ({ archived: true, id: "mem_2", alreadyArchived: false })
  });

  const exec = createExec();
  const args = { id: "mem_2", reason: "user asked to forget" };
  const value = await byName.memory_archive.execute(args, exec);

  assert.equal(calls[0].method, "archive");
  assert.deepEqual(calls[0].args, {
    id: "mem_2",
    reason: "user asked to forget",
    origin: { sessionId: "session_1", toolCallId: "call_1", source: "tool" },
    signal: exec.signal
  });
  assert.deepEqual(value, { archived: true, id: "mem_2", alreadyArchived: false });

  const text = renderedText(byName.memory_archive, args, value);
  assert.match(text, /Archived memory mem_2\. Reason: user asked to forget\./);
  assert.match(
    renderedText(byName.memory_archive, args, { archived: false, id: "mem_2", alreadyArchived: true }),
    /Memory mem_2 was already archived\./
  );
});

test("search is concurrency-safe, writes are not, and timeouts are bounded", () => {
  const { byName } = createHarness();

  assert.equal(byName.memory_search.isConcurrencySafe({ query: "tea" }), true);
  assert.equal(byName.memory_add.isConcurrencySafe({ text: "tea" }), false);
  assert.equal(byName.memory_update.isConcurrencySafe({ id: "mem_1" }), false);
  assert.equal(byName.memory_archive.isConcurrencySafe({ id: "mem_1" }), false);

  assert.equal(byName.memory_search.timeoutMs, 20000);
  assert.equal(byName.memory_add.timeoutMs, 30000);
  assert.equal(byName.memory_update.timeoutMs, 30000);
  assert.equal(byName.memory_archive.timeoutMs, 10000);
});

test("engine errors propagate unchanged", async () => {
  const failure = Object.assign(new Error("memory text is required"), {
    code: "INVALID_INPUT",
    status: 400
  });
  const { byName } = createHarness({
    add: () => {
      throw failure;
    }
  });

  await assert.rejects(byName.memory_add.execute({ text: "" }, createExec()), (error) => {
    assert.equal(error, failure);
    assert.equal(error.code, "INVALID_INPUT");
    return true;
  });
});

test("search results accept engine aliases for score and timestamp", async () => {
  const { byName } = createHarness({
    search: () => ({
      query: "tea",
      retrievalMode: "hybrid",
      results: [{ id: "mem_1", text: "Tea", type: "general", category: "food", score: 0.5, energy: 0.2, timestamp: "2026-02-03" }],
      warnings: []
    })
  });

  const value = await byName.memory_search.execute({ query: "tea" }, createExec());
  assert.equal(value.results[0].similarity, 0.5);
  assert.equal(value.results[0].recorded, "2026-02-03");
});
