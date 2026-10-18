import test from "node:test";
import assert from "node:assert/strict";

import { createBackend } from "../lib/embeddings.js";
import { HermemoryError } from "../lib/errors.js";
import { backendConfig, makeConfig } from "./helpers.js";
import { startFakeBackend } from "./fake-backend.js";

/** Create a backend pointed at the fake server. */
function backendFor(server, kind = "ollama", overrides = {}) {
  return createBackend(
    makeConfig("/tmp/dsh-her-memory-embeddings", {
      backend: backendConfig(server.baseUrl, kind, overrides),
    }),
  );
}

test("ollama backend uses prompt wire format and parses both responses", async (t) => {
  const server = await startFakeBackend({ embedding: [0.1, 0.2, 0.3], chatResponse: "YES" });
  t.after(() => server.close());
  const backend = backendFor(server, "ollama");
  assert.equal(backend.kind, "ollama");

  const vector = await backend.embed("hello world");
  assert.deepEqual(vector, [0.1, 0.2, 0.3]);
  assert.equal(await backend.chat("is this mergeable?", { temperature: 0.2 }), "YES");

  assert.equal(server.requests.length, 2);
  const embedRequest = server.requests[0];
  assert.equal(embedRequest.path, "/api/embeddings");
  assert.deepEqual(embedRequest.json, { model: "test-embed", prompt: "hello world" });
  assert.equal(embedRequest.headers.authorization, undefined);

  const chatRequest = server.requests[1];
  assert.equal(chatRequest.path, "/api/generate");
  assert.deepEqual(chatRequest.json, {
    model: "test-chat",
    prompt: "is this mergeable?",
    stream: false,
    options: { temperature: 0.2 },
  });
});

test("llama-cpp backend uses OpenAI wire format and bearer auth", async (t) => {
  const server = await startFakeBackend({ embedding: [1, 2], chatResponse: "OK" });
  t.after(() => server.close());
  const backend = backendFor(server, "llama-cpp", {
    embedding: { apiKey: "embed-secret" },
    chat: { apiKey: "chat-secret" },
  });

  assert.deepEqual(await backend.embed("hello"), [1, 2]);
  assert.equal(await backend.chat("hello"), "OK");

  const embedRequest = server.requests[0];
  assert.equal(embedRequest.path, "/v1/embeddings");
  assert.deepEqual(embedRequest.json, { model: "test-embed", input: "hello" });
  assert.equal(embedRequest.headers.authorization, "Bearer embed-secret");

  const chatRequest = server.requests[1];
  assert.equal(chatRequest.path, "/v1/chat/completions");
  assert.deepEqual(chatRequest.json, {
    model: "test-chat",
    messages: [{ role: "user", content: "hello" }],
    temperature: 0.1,
    stream: false,
  });
  assert.equal(chatRequest.headers.authorization, "Bearer chat-secret");
});

test("openai-compatible backend shares the OpenAI wire format", async (t) => {
  const server = await startFakeBackend({ embedding: [0.5] });
  t.after(() => server.close());
  const backend = backendFor(server, "openai-compatible");

  assert.deepEqual(await backend.embed("hello"), [0.5]);
  assert.equal(server.requests[0].path, "/v1/embeddings");
  assert.equal(server.requests[0].json.input, "hello");
});

test("HTTP 5xx reports BACKEND_UNAVAILABLE with status and body", async (t) => {
  const server = await startFakeBackend({ behavior: "http-error", httpStatus: 500 });
  t.after(() => server.close());
  const backend = backendFor(server);

  await assert.rejects(
    () => backend.embed("hello"),
    (error) => {
      assert.ok(error instanceof HermemoryError);
      assert.equal(error.code, "BACKEND_UNAVAILABLE");
      assert.equal(error.status, 503);
      assert.equal(error.details.httpStatus, 500);
      assert.match(error.details.body, /fake backend error/);
      return true;
    },
  );
});

test("HTTP 4xx reports an embedding/chat failure", async (t) => {
  const server = await startFakeBackend({ behavior: "http-error", httpStatus: 400 });
  t.after(() => server.close());
  const backend = backendFor(server);

  await assert.rejects(
    () => backend.embed("hello"),
    (error) => error.code === "EMBEDDING_FAILED" && error.details.httpStatus === 400,
  );
  await assert.rejects(
    () => backend.chat("hello"),
    (error) => error.code === "CHAT_FAILED" && error.details.httpStatus === 400,
  );
});

test("malformed JSON reports an operation-specific failure", async (t) => {
  const server = await startFakeBackend({ behavior: "malformed" });
  t.after(() => server.close());
  const backend = backendFor(server);

  await assert.rejects(
    () => backend.embed("hello"),
    (error) => error.code === "EMBEDDING_FAILED",
  );
  await assert.rejects(() => backend.chat("hello"), (error) => error.code === "CHAT_FAILED");
});

test("invalid embedding values are rejected", async (t) => {
  const server = await startFakeBackend({ embedding: ["not-a-number"] });
  t.after(() => server.close());
  const backend = backendFor(server);

  await assert.rejects(
    () => backend.embed("hello"),
    (error) => error.code === "EMBEDDING_FAILED" && /non-finite/.test(error.message),
  );
});

test("empty chat responses are rejected", async (t) => {
  const server = await startFakeBackend({ chatResponse: "" });
  t.after(() => server.close());
  const backend = backendFor(server);

  await assert.rejects(
    () => backend.chat("hello"),
    (error) => error.code === "CHAT_FAILED" && /empty/.test(error.message),
  );
});

test("a slow endpoint times out with BACKEND_UNAVAILABLE", async (t) => {
  const server = await startFakeBackend({ behavior: "timeout", delayMs: 3000 });
  t.after(() => server.close());
  const backend = backendFor(server, "ollama", {
    embedding: { timeoutMs: 100 },
    chat: { timeoutMs: 100 },
  });

  const startedAt = Date.now();
  await assert.rejects(
    () => backend.embed("hello"),
    (error) => error.code === "BACKEND_UNAVAILABLE" && /timed out/.test(error.message),
  );
  assert.ok(Date.now() - startedAt < 2000);
});

test("test() reports embedding and chat probes without throwing", async (t) => {
  const server = await startFakeBackend({ embedding: [1, 2, 3], chatResponse: "OK" });
  t.after(() => server.close());
  const backend = backendFor(server);

  const healthy = await backend.test({ chat: true });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.embedding.ok, true);
  assert.equal(healthy.embedding.dimensions, 3);
  assert.equal(healthy.embedding.model, "test-embed");
  assert.equal(typeof healthy.embedding.latencyMs, "number");
  assert.equal(healthy.chat.ok, true);
  assert.equal(healthy.chat.model, "test-chat");

  server.setBehavior("http-error");
  const broken = await backend.test({ chat: true });
  assert.equal(broken.ok, false);
  assert.equal(broken.embedding.ok, false);
  assert.equal(broken.embedding.code, "BACKEND_UNAVAILABLE");
  assert.equal(broken.chat.ok, false);
});

test("test({ chat: false }) skips the chat probe", async (t) => {
  const server = await startFakeBackend({ embedding: [1] });
  t.after(() => server.close());
  const backend = backendFor(server);

  const report = await backend.test({ chat: false });
  assert.equal(report.ok, true);
  assert.equal(report.embedding.ok, true);
  assert.equal(report.chat.skipped, true);
  assert.equal(report.chat.ok, true);
});

test("the disabled backend throws BACKEND_UNAVAILABLE and reports disabled", async () => {
  const backend = createBackend({ backend: { kind: "none" } });
  assert.equal(backend.kind, "none");

  await assert.rejects(
    () => backend.embed("hello"),
    (error) => error.code === "BACKEND_UNAVAILABLE" && /disabled/.test(error.message),
  );
  await assert.rejects(
    () => backend.chat("hello"),
    (error) => error.code === "BACKEND_UNAVAILABLE",
  );

  const report = await backend.test({ chat: true });
  assert.equal(report.ok, false);
  assert.equal(report.reason, "disabled");
  assert.equal(report.embedding.ok, false);
  assert.equal(report.chat.ok, false);
});

test("an aborted caller signal surfaces as BACKEND_UNAVAILABLE", async (t) => {
  const server = await startFakeBackend({ behavior: "timeout", delayMs: 3000 });
  t.after(() => server.close());
  const backend = backendFor(server);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => backend.embed("hello", { signal: controller.signal }),
    (error) => error.code === "BACKEND_UNAVAILABLE",
  );
});
