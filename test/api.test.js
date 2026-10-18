import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { API_PATH, MAX_BODY_BYTES, registerApi } from "../lib/api.js";
import { MEMORY_TOOL_NAMES } from "../lib/tools.js";

const HOST = "127.0.0.1:3080";
const SAME_ORIGIN_HEADERS = {
  host: HOST,
  origin: `http://${HOST}`,
  "sec-fetch-site": "same-origin"
};

/** Build a fake context and engine, then run the real route registration. */
function createHarness(implementations = {}, engineProperties = {}) {
  const calls = [];
  const logs = [];
  let route;
  const engine = {};
  for (const method of [
    "getState",
    "saveConfig",
    "testBackend",
    "search",
    "list",
    "add",
    "update",
    "archive",
    "delete",
    "maintain",
    "backfill",
    "stamp",
    "propose",
    "listProposals",
    "getProposal",
    "executeProposal",
    "restoreProposal",
    "exportData",
    "importData"
  ]) {
    engine[method] = async (...args) => {
      calls.push({ method, args });
      const implementation = implementations[method];
      return typeof implementation === "function" ? implementation(...args) : { method };
    };
  }
  Object.assign(engine, engineProperties);

  const ctx = {
    webServer: {
      register(definition) {
        route = definition;
        return () => {};
      }
    },
    effect(callback) {
      return callback();
    },
    logger: {
      error(message) {
        logs.push(message);
      },
      warn() {},
      debug() {}
    }
  };

  registerApi(ctx, engine);
  return { route, calls, logs, engine };
}

/** Build a readable mock request carrying method, headers, and an optional body. */
function makeRequest({ method = "GET", headers = SAME_ORIGIN_HEADERS, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)];
  const request = Readable.from(chunks);
  request.method = method;
  request.headers = headers;
  request.url = API_PATH;
  return request;
}

/** Build a mock response that captures status, headers, and body. */
function makeResponse() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = { ...headers };
    },
    setHeader(name, value) {
      this.headers = { ...this.headers, [name]: value };
    },
    end(chunk) {
      if (chunk !== undefined) this.body = String(chunk);
      this.ended = true;
    }
  };
}

/** Invoke the registered handler and decode its JSON body. */
async function invoke(route, request) {
  const response = makeResponse();
  await route.handler(request, response);
  return {
    response,
    json: response.body === undefined ? undefined : JSON.parse(response.body)
  };
}

/** Build a POST request with JSON content type and same-origin headers. */
function postRequest(action, payload) {
  return makeRequest({
    method: "POST",
    headers: { ...SAME_ORIGIN_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ action, payload })
  });
}

test("registers one exact API route", () => {
  const { route } = createHarness();
  assert.equal(route.kind, "exact");
  assert.equal(route.path, "/plugins/dsh-her-memory/api");
  assert.equal(typeof route.handler, "function");
});

test("GET returns the engine state with the skill and tool catalog", async () => {
  const state = {
    plugin: { name: "her-memory", version: "0.1.0" },
    config: { maintenance: { enabled: true } },
    paths: { home: "/tmp/her-memory" },
    stats: { total: 2 },
    status: { healthy: true },
    capabilities: { embeddings: false }
  };
  const { route, calls } = createHarness({ getState: () => state });

  const { response, json } = await invoke(route, makeRequest());

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(json.ok, true);
  assert.deepEqual(json.value.plugin, state.plugin);
  assert.deepEqual(json.value.config, state.config);
  assert.deepEqual(json.value.paths, state.paths);
  assert.deepEqual(json.value.stats, state.stats);
  assert.deepEqual(json.value.status, state.status);
  assert.deepEqual(json.value.capabilities, state.capabilities);
  assert.deepEqual(json.value.tools, [...MEMORY_TOOL_NAMES]);
  assert.deepEqual(
    json.value.skills.map((skill) => skill.name),
    ["her-memory", "memory-recall", "memory-capture", "memory-curation"]
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "getState");
});

test("GET keeps catalog fields the engine already provides", async () => {
  const skills = [{ name: "custom-skill", description: "From the engine." }];
  const tools = ["custom_tool"];
  const { route } = createHarness({
    getState: () => ({ plugin: {}, skills, tools, capabilities: {} })
  });

  const { json } = await invoke(route, makeRequest());
  assert.deepEqual(json.value.skills, skills);
  assert.deepEqual(json.value.tools, tools);
});

test("POST memories.search dispatches the payload", async () => {
  const searchResult = { query: "tea", retrievalMode: "hybrid", results: [], warnings: [] };
  const { route, calls } = createHarness({ search: (payload) => ({ ...searchResult, query: payload.query }) });

  const { response, json } = await invoke(route, postRequest("memories.search", { query: "tea", topK: 5 }));

  assert.equal(response.statusCode, 200);
  assert.equal(json.ok, true);
  assert.deepEqual(json.value, searchResult);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "search");
  assert.deepEqual(calls[0].args, [{ query: "tea", topK: 5, logHits: false }]);
});

test("POST config.save strips read-only apiKeySet markers", async () => {
  const saved = [];
  const { route } = createHarness({
    saveConfig: (patch) => {
      saved.push(patch);
      return { saved: true };
    }
  });

  const { response, json } = await invoke(route, postRequest("config.save", {
    backend: {
      kind: "ollama",
      embedding: { model: "nomic", apiKey: "local", apiKeySet: true },
      chat: { model: "llama", apiKeySet: false }
    },
    maintenance: { enabled: true }
  }));

  assert.equal(response.statusCode, 200);
  assert.equal(json.ok, true);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], {
    backend: {
      kind: "ollama",
      embedding: { model: "nomic", apiKey: "local" },
      chat: { model: "llama" }
    },
    maintenance: { enabled: true }
  });
  assert.equal(JSON.stringify(saved[0]).includes("apiKeySet"), false);
});

test("successful responses redact secret-bearing keys", async () => {
  const { route } = createHarness({
    saveConfig: () => ({
      config: { backend: { chat: { apiKey: "sk-live-secret", token: "tok" } } },
      saved: true
    })
  });

  const { json } = await invoke(route, postRequest("config.save", { backend: {} }));

  assert.equal(json.ok, true);
  assert.equal(json.value.config.backend.chat.apiKey, "[redacted]");
  assert.equal(json.value.config.backend.chat.token, "[redacted]");
  assert.equal(JSON.stringify(json).includes("sk-live-secret"), false);
});

test("POST settings writes attach settings provenance", async () => {
  const { route, calls } = createHarness({
    add: () => ({ added: true }),
    update: () => ({ updated: true }),
    archive: () => ({ archived: true })
  });

  await invoke(route, postRequest("memories.add", { text: "Likes tea" }));
  await invoke(route, postRequest("memories.update", { id: "mem_1", text: "Likes green tea" }));
  await invoke(route, postRequest("memories.archive", { id: "mem_1", reason: "old" }));

  assert.deepEqual(calls[0], {
    method: "add",
    args: [{ text: "Likes tea", origin: { source: "settings" } }]
  });
  assert.deepEqual(calls[1], {
    method: "update",
    args: [{ id: "mem_1", text: "Likes green tea", origin: { source: "settings" } }]
  });
  assert.deepEqual(calls[2], {
    method: "archive",
    args: [{ id: "mem_1", reason: "old", origin: { source: "settings" } }]
  });
});

test("POST memories.delete forwards confirm to the engine", async () => {
  const { route, calls } = createHarness({ delete: () => ({ deleted: true }) });

  const { json } = await invoke(route, postRequest("memories.delete", { id: "mem_1", confirm: true }));

  assert.equal(json.ok, true);
  assert.equal(calls[0].method, "delete");
  assert.deepEqual(calls[0].args, [{ id: "mem_1", confirm: true }]);
});

test("maintenance.run maps each requested maintenance action", async () => {
  const { route, calls } = createHarness();

  await invoke(route, postRequest("maintenance.run", { action: "backfill" }));
  await invoke(route, postRequest("maintenance.run", { action: "backfillAll" }));
  await invoke(route, postRequest("maintenance.run", { action: "stamp" }));
  await invoke(route, postRequest("maintenance.run", {}));

  assert.deepEqual(calls.map((call) => call.method), ["backfill", "backfill", "stamp", "maintain"]);
  assert.deepEqual(calls[0].args, [{ action: "backfill" }]);
  assert.deepEqual(calls[1].args, [{ action: "backfillAll", all: true }]);
  assert.deepEqual(calls[2].args, []);
  assert.deepEqual(calls[3].args, []);
});

test("consolidation and data actions dispatch to the engine", async () => {
  const { route, calls } = createHarness();

  await invoke(route, postRequest("consolidation.propose", {}));
  await invoke(route, postRequest("consolidation.list", {}));
  await invoke(route, postRequest("consolidation.get", { id: "proposal_1" }));
  await invoke(route, postRequest("consolidation.execute", { id: "proposal_1", groups: [] }));
  await invoke(route, postRequest("consolidation.restore", { id: "proposal_1" }));
  await invoke(route, postRequest("data.export", {}));
  await invoke(route, postRequest("data.import", { jsonl: "{}\n", backfill: false }));

  assert.deepEqual(calls.map((call) => call.method), [
    "propose",
    "listProposals",
    "getProposal",
    "executeProposal",
    "restoreProposal",
    "exportData",
    "importData"
  ]);
  assert.deepEqual(calls[2].args, ["proposal_1"]);
  assert.deepEqual(calls[3].args, [{ id: "proposal_1", groups: [] }]);
  assert.deepEqual(calls[4].args, ["proposal_1"]);
  assert.deepEqual(calls[6].args, [{ jsonl: "{}\n", backfill: false }]);
});

test("state action returns the augmented state envelope", async () => {
  const { route } = createHarness({
    getState: () => ({ plugin: { name: "her-memory" }, stats: { total: 1 } })
  });

  const { response, json } = await invoke(route, postRequest("state", {}));

  assert.equal(response.statusCode, 200);
  assert.equal(json.ok, true);
  assert.equal(json.value.plugin.name, "her-memory");
  assert.deepEqual(json.value.tools, [...MEMORY_TOOL_NAMES]);
  assert.equal(json.value.skills.length, 4);
});

test("unknown actions are rejected without touching the engine", async () => {
  const { route, calls } = createHarness();

  const { response, json } = await invoke(route, postRequest("memories.explode", {}));

  assert.equal(response.statusCode, 400);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, "INVALID_INPUT");
  assert.equal(json.error.status, 400);
  assert.match(json.error.message, /Unknown action "memories\.explode"/);
  assert.equal(calls.length, 0);
});

test("cross-site requests are rejected", async () => {
  const { route, calls } = createHarness();

  const { response, json } = await invoke(route, makeRequest({
    method: "POST",
    headers: { ...SAME_ORIGIN_HEADERS, "sec-fetch-site": "cross-site", "content-type": "application/json" },
    body: JSON.stringify({ action: "state", payload: {} })
  }));

  assert.equal(response.statusCode, 403);
  assert.equal(json.error.code, "INVALID_INPUT");
  assert.match(json.error.message, /Cross-site/);
  assert.equal(calls.length, 0);
});

test("cross-origin requests and missing host headers are rejected", async () => {
  const { route, calls } = createHarness();

  const crossOrigin = await invoke(route, makeRequest({
    headers: { host: HOST, origin: "http://evil.example" }
  }));
  assert.equal(crossOrigin.response.statusCode, 403);
  assert.match(crossOrigin.json.error.message, /Cross-origin/);

  const missingHost = await invoke(route, makeRequest({
    headers: { origin: `http://${HOST}` }
  }));
  assert.equal(missingHost.response.statusCode, 403);
  assert.match(missingHost.json.error.message, /Host header/);

  assert.equal(calls.length, 0);
});

test("POST requires application/json", async () => {
  const { route, calls } = createHarness();

  const { response, json } = await invoke(route, makeRequest({
    method: "POST",
    headers: SAME_ORIGIN_HEADERS,
    body: JSON.stringify({ action: "state", payload: {} })
  }));

  assert.equal(response.statusCode, 415);
  assert.equal(json.error.code, "INVALID_INPUT");
  assert.match(json.error.message, /application\/json/);
  assert.equal(calls.length, 0);
});

test("invalid JSON bodies are rejected", async () => {
  const { route, calls } = createHarness();

  const { response, json } = await invoke(route, makeRequest({
    method: "POST",
    headers: { ...SAME_ORIGIN_HEADERS, "content-type": "application/json" },
    body: "{not json"
  }));

  assert.equal(response.statusCode, 400);
  assert.equal(json.error.code, "INVALID_INPUT");
  assert.match(json.error.message, /valid JSON/);
  assert.equal(calls.length, 0);
});

test("oversized bodies are rejected with 413", async () => {
  const { route, calls } = createHarness();
  const body = Buffer.alloc(MAX_BODY_BYTES + 1, 0x20);

  const { response, json } = await invoke(route, makeRequest({
    method: "POST",
    headers: { ...SAME_ORIGIN_HEADERS, "content-type": "application/json" },
    body
  }));

  assert.equal(response.statusCode, 413);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, "INVALID_INPUT");
  assert.match(json.error.message, /exceeds/);
  assert.equal(calls.length, 0);
});

test("unsupported methods are rejected with 405", async () => {
  const { route, calls } = createHarness();

  const { response, json } = await invoke(route, makeRequest({ method: "PUT" }));

  assert.equal(response.statusCode, 405);
  assert.equal(json.error.code, "INVALID_INPUT");
  assert.equal(calls.length, 0);
});

test("engine errors map to their declared status, code, and details", async () => {
  const { route } = createHarness({
    search: () => {
      throw Object.assign(new Error("query is required"), {
        code: "INVALID_INPUT",
        status: 422,
        details: { field: "query" }
      });
    }
  });

  const { response, json } = await invoke(route, postRequest("memories.search", {}));

  assert.equal(response.statusCode, 422);
  assert.equal(json.ok, false);
  assert.deepEqual(json.error, {
    code: "INVALID_INPUT",
    message: "query is required",
    status: 422,
    details: { field: "query" }
  });
});

test("unexpected errors become 500 UNKNOWN and are logged", async () => {
  const { route, logs } = createHarness({
    getState: () => {
      throw new Error("disk exploded");
    }
  });

  const { response, json } = await invoke(route, makeRequest());

  assert.equal(response.statusCode, 500);
  assert.equal(json.error.code, "UNKNOWN");
  assert.equal(json.error.status, 500);
  assert.equal(json.error.message, "disk exploded");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /API GET failed: disk exploded/);
});

test("engine initialization failures return a clear 500", async () => {
  const { route, calls } = createHarness({}, { initError: new Error("config.json is invalid") });

  const { response, json } = await invoke(route, makeRequest());

  assert.equal(response.statusCode, 500);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, "UNKNOWN");
  assert.match(json.error.message, /failed to initialize/);
  assert.match(json.error.message, /config\.json is invalid/);
  assert.equal(calls.length, 0);
});

test("error details are redacted before they leave the API", async () => {
  const { route } = createHarness({
    testBackend: () => {
      throw Object.assign(new Error("backend rejected the key"), {
        code: "CHAT_FAILED",
        status: 502,
        details: { apiKey: "sk-live-secret" }
      });
    }
  });

  const { json } = await invoke(route, postRequest("backend.test", {}));

  assert.equal(json.error.details.apiKey, "[redacted]");
  assert.equal(JSON.stringify(json).includes("sk-live-secret"), false);
});
