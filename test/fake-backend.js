/**
 * A tiny HTTP server speaking both backend wire protocols for tests.
 *
 * Routes:
 * - `POST /api/embeddings` and `POST /api/generate` (Ollama)
 * - `POST /v1/embeddings` and `POST /v1/chat/completions` (OpenAI-compatible)
 *
 * Behaviour can be switched between `success`, `http-error`, `timeout`, and
 * `malformed` while the server is running. No model runtime is required.
 *
 * @module test/fake-backend
 */

import http from "node:http";

/**
 * Start the fake backend on an ephemeral port.
 *
 * @param {object} [options]
 * @param {"success"|"http-error"|"timeout"|"malformed"} [options.behavior="success"]
 * @param {number} [options.httpStatus=500] Status used by `http-error`.
 * @param {number} [options.delayMs=5000] Delay used by `timeout`.
 * @param {number[]} [options.embedding=[0.1,0.2,0.3]] Embedding returned.
 * @param {string} [options.chatResponse="YES"] Chat text returned.
 * @returns {Promise<object>} Server handle.
 */
export async function startFakeBackend(options = {}) {
  const state = {
    behavior: options.behavior ?? "success",
    httpStatus: options.httpStatus ?? 500,
    delayMs: options.delayMs ?? 5000,
    embedding: options.embedding ?? [0.1, 0.2, 0.3],
    chatResponse: options.chatResponse ?? "YES",
    requests: [],
    timers: new Set(),
  };

  const server = http.createServer((request, response) => {
    void handleRequest(request, response, state);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    port,
    requests: state.requests,
    get behavior() {
      return state.behavior;
    },
    setBehavior(behavior) {
      state.behavior = behavior;
    },
    setChatResponse(chatResponse) {
      state.chatResponse = chatResponse;
    },
    setEmbedding(embedding) {
      state.embedding = embedding;
    },
    setDelay(delayMs) {
      state.delayMs = delayMs;
    },
    async close() {
      for (const timer of state.timers) {
        clearTimeout(timer);
      }
      state.timers.clear();
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Read the JSON request body. */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      resolve({ text, json });
    });
    request.on("error", reject);
  });
}

/** Sleep with a tracked timer so `close()` can cancel pending timeouts. */
function trackedSleep(state, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.timers.delete(timer);
      resolve();
    }, ms);
    state.timers.add(timer);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

/** Write a JSON response. */
function sendJson(response, status, payload) {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

/** Main request handler. */
async function handleRequest(request, response, state) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const pathname = url.pathname;
  const { text, json } = await readBody(request);
  state.requests.push({
    method: request.method,
    path: pathname,
    headers: request.headers,
    body: text,
    json,
  });

  if (state.behavior === "timeout") {
    await trackedSleep(state, state.delayMs);
    if (response.destroyed) {
      return;
    }
  }

  if (state.behavior === "http-error") {
    if (!response.destroyed) {
      response.writeHead(state.httpStatus, { "content-type": "text/plain" });
      response.end("fake backend error");
    }
    return;
  }

  if (state.behavior === "malformed") {
    if (!response.destroyed) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("this is not json");
    }
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "method not allowed" });
    return;
  }

  if (pathname === "/api/embeddings") {
    sendJson(response, 200, { embedding: state.embedding });
    return;
  }
  if (pathname === "/api/generate") {
    sendJson(response, 200, { response: state.chatResponse });
    return;
  }
  if (pathname === "/v1/embeddings") {
    sendJson(response, 200, {
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: state.embedding }],
    });
    return;
  }
  if (pathname === "/v1/chat/completions") {
    sendJson(response, 200, {
      choices: [{ message: { role: "assistant", content: state.chatResponse } }],
    });
    return;
  }

  sendJson(response, 404, { error: "not found" });
}
