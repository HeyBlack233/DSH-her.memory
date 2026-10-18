/**
 * Model backend adapters: Ollama, llama.cpp/OpenAI-compatible, and a disabled
 * backend for keyword-only operation.
 *
 * Every network call is normalized into {@link HermemoryError} codes so callers
 * can degrade gracefully: search falls back to BM25, and a write stores the
 * memory without an embedding.
 *
 * @module embeddings
 */

import { DEFAULT_CONFIG } from "./config.js";
import { HermemoryError } from "./errors.js";
import { deepMerge } from "./util.js";

/** Fixed probe text used by {@link createBackend}'s `test()`. */
const PROBE_TEXT = "her.memory backend probe";

/**
 * Combine a timeout signal with a caller-provided signal.
 *
 * @param {AbortSignal} timeoutSignal Signal that aborts on timeout.
 * @param {AbortSignal|undefined} callerSignal Optional caller signal.
 * @returns {AbortSignal}
 */
function combineSignals(timeoutSignal, callerSignal) {
  if (!callerSignal) {
    return timeoutSignal;
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([timeoutSignal, callerSignal]);
  }

  const controller = new AbortController();
  const abort = (source) => () => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason);
    }
  };
  if (timeoutSignal.aborted) {
    abort(timeoutSignal)();
  } else {
    timeoutSignal.addEventListener("abort", abort(timeoutSignal), { once: true });
  }
  if (callerSignal.aborted) {
    abort(callerSignal)();
  } else {
    callerSignal.addEventListener("abort", abort(callerSignal), { once: true });
  }
  return controller.signal;
}

/** Operation-specific error factory. */
function operationError(operation, message, options = {}) {
  const code = operation === "embedding" ? "EMBEDDING_FAILED" : "CHAT_FAILED";
  return new HermemoryError(code, message, options);
}

/**
 * POST a JSON body and normalize transport/HTTP/parse failures.
 *
 * @param {object} params
 * @param {string} params.url Endpoint URL.
 * @param {object} params.payload JSON payload.
 * @param {string} params.apiKey Optional bearer token.
 * @param {number} params.timeoutMs Request timeout.
 * @param {AbortSignal} [params.signal] Caller cancellation signal.
 * @param {string} params.kind Backend kind (for error messages).
 * @param {"embedding"|"chat"} params.operation Operation name.
 * @returns {Promise<object>} Parsed JSON object.
 */
async function postJson({
  url,
  payload,
  apiKey,
  timeoutMs,
  signal,
  kind,
  operation,
}) {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeout));
  const combined = combineSignals(timeoutSignal, signal);

  const headers = { "content-type": "application/json" };
  if (typeof apiKey === "string" && apiKey.length > 0) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: combined,
    });
  } catch (error) {
    const timedOut =
      error &&
      (error.name === "AbortError" || error.name === "TimeoutError" || combined.aborted);
    throw new HermemoryError(
      "BACKEND_UNAVAILABLE",
      timedOut
        ? `${kind} ${operation} request timed out or was aborted: ${url}`
        : `${kind} backend is unreachable: ${url}`,
      {
        status: 503,
        details: { kind, url, timeoutMs: timeout, reason: error?.message || String(error) },
        cause: error,
      },
    );
  }

  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch (error) {
    throw operationError(operation, `Failed to read ${kind} response: ${url}`, {
      status: 502,
      details: { kind, url, httpStatus: response.status },
      cause: error,
    });
  }

  let data = null;
  if (bodyText.trim()) {
    try {
      data = JSON.parse(bodyText);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const body = bodyText.slice(0, 300);
    const details = { kind, url, httpStatus: response.status, body };
    if (response.status >= 500) {
      throw new HermemoryError(
        "BACKEND_UNAVAILABLE",
        `${kind} ${operation} endpoint returned HTTP ${response.status}: ${url}`,
        { status: 503, details },
      );
    }
    throw operationError(
      operation,
      `${kind} ${operation} endpoint returned HTTP ${response.status}: ${url}`,
      { status: 502, details },
    );
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw operationError(operation, `${kind} returned a non-object JSON payload: ${url}`, {
      status: 502,
      details: { kind, url, body: bodyText.slice(0, 300) },
    });
  }

  return data;
}

/**
 * Validate and copy an embedding vector.
 *
 * @param {*} value Raw payload value.
 * @param {string} kind Backend kind for messages.
 * @returns {number[]}
 */
function coerceEmbedding(value, kind) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HermemoryError("EMBEDDING_FAILED", `${kind} returned an empty embedding`, {
      status: 502,
      details: { kind },
    });
  }
  const output = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw new HermemoryError(
        "EMBEDDING_FAILED",
        `${kind} returned an embedding containing non-finite values`,
        { status: 502, details: { kind } },
      );
    }
    output.push(item);
  }
  return output;
}

/** Require a non-empty string chat response. */
function coerceChatResponse(value, kind) {
  if (typeof value !== "string" || !value.trim()) {
    throw new HermemoryError("CHAT_FAILED", `${kind} returned an empty chat response`, {
      status: 502,
      details: { kind },
    });
  }
  return value;
}

/**
 * Build a backend adapter from configuration.
 *
 * @param {object} config Full plugin configuration (or a backend block).
 * @returns {{kind: string, embed: Function, chat: Function, test: Function}}
 * @throws {HermemoryError} `INVALID_INPUT` for an unknown backend kind.
 */
export function createBackend(config = {}) {
  const source = config && typeof config === "object" && config.backend ? config.backend : config;
  const backendConfig = deepMerge(DEFAULT_CONFIG.backend, source || {});
  const kind = backendConfig.kind;

  if (kind === "none") {
    const disabled = () => {
      throw new HermemoryError(
        "BACKEND_UNAVAILABLE",
        "Model backend is disabled; set backend.kind to ollama, llama-cpp, or openai-compatible",
        { status: 503, details: { kind: "none" } },
      );
    };
    return {
      kind,
      embed: async () => disabled(),
      chat: async () => disabled(),
      /**
       * Probe that reports the disabled state without throwing.
       *
       * @param {object} [options]
       * @param {boolean} [options.chat=true] Included for API symmetry.
       * @returns {Promise<object>}
       */
      test: async () => ({
        ok: false,
        reason: "disabled",
        embedding: { ok: false, model: backendConfig.embedding.model },
        chat: { ok: false, model: backendConfig.chat.model },
      }),
    };
  }

  if (!["ollama", "llama-cpp", "openai-compatible"].includes(kind)) {
    throw new HermemoryError("INVALID_INPUT", `Unknown backend kind: ${kind}`, {
      status: 400,
      details: { path: "backend.kind", value: kind },
    });
  }

  const embeddingConfig = backendConfig.embedding;
  const chatConfig = backendConfig.chat;

  const embed = async (text, { signal } = {}) => {
    if (typeof text !== "string") {
      throw new HermemoryError("INVALID_INPUT", "embedding text must be a string", {
        status: 400,
        details: { path: "text" },
      });
    }

    if (kind === "ollama") {
      const data = await postJson({
        url: embeddingConfig.url,
        payload: { model: embeddingConfig.model, prompt: text },
        apiKey: embeddingConfig.apiKey,
        timeoutMs: embeddingConfig.timeoutMs,
        signal,
        kind,
        operation: "embedding",
      });
      return coerceEmbedding(data.embedding, kind);
    }

    const data = await postJson({
      url: embeddingConfig.url,
      payload: { model: embeddingConfig.model, input: text },
      apiKey: embeddingConfig.apiKey,
      timeoutMs: embeddingConfig.timeoutMs,
      signal,
      kind,
      operation: "embedding",
    });
    const items = data.data;
    if (!Array.isArray(items) || items.length === 0 || !items[0] || typeof items[0] !== "object") {
      throw new HermemoryError("EMBEDDING_FAILED", `${kind} returned an empty embedding list`, {
        status: 502,
        details: { kind },
      });
    }
    return coerceEmbedding(items[0].embedding, kind);
  };

  const chat = async (prompt, { temperature = 0.1, signal } = {}) => {
    if (typeof prompt !== "string") {
      throw new HermemoryError("INVALID_INPUT", "chat prompt must be a string", {
        status: 400,
        details: { path: "prompt" },
      });
    }

    if (kind === "ollama") {
      const data = await postJson({
        url: chatConfig.url,
        payload: {
          model: chatConfig.model,
          prompt,
          stream: false,
          options: { temperature },
        },
        apiKey: chatConfig.apiKey,
        timeoutMs: chatConfig.timeoutMs,
        signal,
        kind,
        operation: "chat",
      });
      return coerceChatResponse(data.response, kind);
    }

    const data = await postJson({
      url: chatConfig.url,
      payload: {
        model: chatConfig.model,
        messages: [{ role: "user", content: prompt }],
        temperature,
        stream: false,
      },
      apiKey: chatConfig.apiKey,
      timeoutMs: chatConfig.timeoutMs,
      signal,
      kind,
      operation: "chat",
    });
    const choices = data.choices;
    const content =
      Array.isArray(choices) && choices[0] && choices[0].message
        ? choices[0].message.content
        : null;
    return coerceChatResponse(content, kind);
  };

  return {
    kind,

    /**
     * Generate an embedding vector.
     *
     * @param {string} text Text to embed.
     * @param {object} [options]
     * @param {AbortSignal} [options.signal] Cancellation signal.
     * @returns {Promise<number[]>}
     */
    embed,

    /**
     * Generate chat text.
     *
     * @param {string} prompt Prompt text.
     * @param {object} [options]
     * @param {number} [options.temperature=0.1] Sampling temperature.
     * @param {AbortSignal} [options.signal] Cancellation signal.
     * @returns {Promise<string>}
     */
    chat,

    /**
     * Probe embedding and (optionally) chat, never throwing.
     *
     * @param {object} [options]
     * @param {boolean} [options.chat=true] Probe chat too.
     * @returns {Promise<object>} Probe report.
     */
    test: async ({ chat: probeChat = true } = {}) => {
      const embedding = {
        ok: false,
        latencyMs: 0,
        dimensions: 0,
        model: embeddingConfig.model,
      };
      const startedAt = performance.now();
      try {
        const vector = await embed(PROBE_TEXT);
        embedding.ok = true;
        embedding.dimensions = vector.length;
        embedding.latencyMs = Math.round(performance.now() - startedAt);
      } catch (error) {
        embedding.latencyMs = Math.round(performance.now() - startedAt);
        embedding.error = error?.message || String(error);
        embedding.code = error?.code || "EMBEDDING_FAILED";
      }

      const chatProbe = {
        ok: false,
        latencyMs: 0,
        model: chatConfig.model,
      };
      if (probeChat) {
        const chatStartedAt = performance.now();
        try {
          await chat("Reply with the single word OK.", { temperature: 0 });
          chatProbe.ok = true;
        } catch (error) {
          chatProbe.error = error?.message || String(error);
          chatProbe.code = error?.code || "CHAT_FAILED";
        }
        chatProbe.latencyMs = Math.round(performance.now() - chatStartedAt);
      } else {
        chatProbe.skipped = true;
        chatProbe.ok = true;
      }

      return {
        ok: embedding.ok && chatProbe.ok,
        embedding,
        chat: chatProbe,
      };
    },
  };
}
