/**
 * Same-origin JSON API for the settings page.
 *
 * One exact route serves both the initial state read and every settings
 * action. The handler owns HTTP concerns only: trust checks, body limits,
 * action dispatch onto the shared engine, and error/secret shaping.
 *
 * @module @local/dsh-her-memory/api
 */

import { HermemoryError } from "./errors.js";
import { getRegisteredSkills } from "./skills.js";
import { MEMORY_TOOL_NAMES } from "./tools.js";

/** The one route this plugin owns. */
export const API_PATH = "/plugins/dsh-her-memory/api";

/** Maximum accepted request body, in bytes. */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;

/** Secret-bearing config keys that must never cross the API boundary. */
const SECRET_KEY_PATTERN = /^(api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|secret|client[-_]?secret|password|authorization)$/i;

/** Whether a value is a plain object. */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Replace secret-bearing values anywhere in a JSON-shaped value. */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redact(entry);
  }
  return result;
}

/** Copy a config patch and remove read-only redaction markers. */
function prepareConfigPatch(payload) {
  const patch = structuredClone(payload);
  if (!isRecord(patch) || !isRecord(patch.backend)) return patch;
  for (const name of ["embedding", "chat"]) {
    const section = patch.backend[name];
    if (isRecord(section) && Object.hasOwn(section, "apiKeySet")) delete section.apiKeySet;
  }
  return patch;
}

/** Build the public state shape, filling in the catalog when the engine omits it. */
function withCatalog(state) {
  const base = isRecord(state) ? state : {};
  return {
    ...base,
    skills:
      Array.isArray(base.skills) && base.skills.length > 0
        ? base.skills
        : getRegisteredSkills(),
    tools:
      Array.isArray(base.tools) && base.tools.length > 0
        ? base.tools
        : [...MEMORY_TOOL_NAMES],
    capabilities: isRecord(base.capabilities) ? base.capabilities : {}
  };
}

/** The initialization failure an engine reports, when it exposes one. */
function initializationFailure(engine) {
  for (const candidate of [engine?.initError, engine?.initializationError, engine?.api?.initError]) {
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  return undefined;
}

/** Reject cross-site and cross-origin browser requests. */
function trustRejection(req) {
  const site = String(req.headers?.["sec-fetch-site"] ?? "").toLowerCase();
  if (site === "cross-site") {
    return { status: 403, message: "Cross-site requests are not allowed." };
  }
  const origin = req.headers?.origin;
  if (origin === undefined || origin === null || String(origin).length === 0) return undefined;
  let originHost;
  try {
    originHost = new URL(String(origin)).host;
  } catch {
    return { status: 403, message: "The Origin header is not a valid URL." };
  }
  const host = req.headers?.host;
  if (typeof host !== "string" || host.length === 0) {
    return { status: 403, message: "An Origin request requires a Host header." };
  }
  if (originHost.toLowerCase() !== host.toLowerCase()) {
    return { status: 403, message: "Cross-origin requests are not allowed." };
  }
  return undefined;
}

/** Whether a write declared the JSON content type. */
function isJsonContentType(req) {
  const value = req.headers?.["content-type"];
  if (typeof value !== "string") return false;
  return value.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

/** Read a request body up to `limit` bytes, draining an oversized stream. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      if (tooLarge) {
        fail(Object.assign(new Error("request body is too large"), { code: "BODY_TOO_LARGE" }));
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => fail(error));
    req.on("aborted", () => fail(new Error("request aborted")));
  });
}

/** Build an error carrying the engine's stable code/status contract. */
function apiError(code, message, status = 400, details) {
  return new HermemoryError(code, message, { status, details });
}

/** Normalize any thrown value into the public failure shape. */
function failureOf(error) {
  const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : "UNKNOWN";
  const declaredStatus = error?.status;
  const status = Number.isInteger(declaredStatus) && declaredStatus >= 400 && declaredStatus <= 599
    ? declaredStatus
    : (code === "UNKNOWN" ? 500 : 400);
  const message = typeof error?.message === "string" && error.message.length > 0
    ? error.message
    : "The request failed.";
  return { code, status, message, details: error?.details };
}

/** Write one JSON response without caching it in the browser. */
function sendJson(res, status, body, extraHeaders) {
  if (res.headersSent || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders
  });
  res.end(text);
}

/** Write one successful response envelope. */
function sendSuccess(res, value) {
  sendJson(res, 200, { ok: true, value: redact(value) });
}

/** Write one failure response envelope. */
function sendFailure(res, status, code, message, details) {
  sendJson(res, status, {
    ok: false,
    error: {
      code,
      message,
      status,
      ...details === undefined ? {} : { details: redact(details) }
    }
  });
}

/** Report an unexpected engine failure without echoing request data. */
function reportFailure(ctx, action, failure) {
  if (failure.code !== "UNKNOWN") return;
  const message = `[her-memory] API ${action ?? "request"} failed: ${failure.message}`;
  if (typeof ctx.logger?.error === "function") ctx.logger.error(message);
  else if (typeof console !== "undefined" && typeof console.error === "function") console.error(message);
}

/** Dispatch one settings action onto the engine. */
async function dispatch(engine, action, payload) {
  switch (action) {
    case "state":
      return withCatalog(await engine.getState());
    case "config.save":
      return engine.saveConfig(prepareConfigPatch(payload));
    case "backend.test":
      return engine.testBackend(payload);
    case "memories.search":
      return engine.search({ ...payload, logHits: false });
    case "memories.list":
      return engine.list(payload);
    case "memories.add":
      return engine.add({ ...payload, origin: { source: "settings" } });
    case "memories.update":
      return engine.update({ ...payload, origin: { source: "settings" } });
    case "memories.archive":
      return engine.archive({ ...payload, origin: { source: "settings" } });
    case "memories.delete":
      return engine.delete(payload);
    case "maintenance.run":
      if (payload.action === "backfill") return engine.backfill(payload);
      if (payload.action === "backfillAll") return engine.backfill({ ...payload, all: true });
      if (payload.action === "stamp") return engine.stamp();
      return engine.maintain();
    case "consolidation.propose":
      return engine.propose();
    case "consolidation.list":
      return engine.listProposals();
    case "consolidation.get":
      return engine.getProposal(payload.id);
    case "consolidation.execute":
      return engine.executeProposal(payload);
    case "consolidation.restore":
      return engine.restoreProposal(payload.id);
    case "data.export":
      return engine.exportData();
    case "data.import":
      return engine.importData(payload);
    default:
      throw apiError("INVALID_INPUT", `Unknown action "${action}".`, 400);
  }
}

/** Own one HTTP request for the settings API. */
async function handleRequest(ctx, engine, req, res) {
  let action;
  try {
    const method = String(req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      sendFailure(res, 405, "INVALID_INPUT", `Method ${method} is not allowed; use GET or POST.`);
      return;
    }

    const rejection = trustRejection(req);
    if (rejection !== undefined) {
      sendFailure(res, rejection.status, "INVALID_INPUT", rejection.message);
      return;
    }

    const initFailure = initializationFailure(engine);
    if (initFailure !== undefined) {
      const detail = initFailure instanceof Error ? initFailure.message : String(initFailure);
      sendFailure(res, 500, "UNKNOWN", `her-memory engine failed to initialize: ${detail}`);
      return;
    }

    if (method === "GET") {
      action = "GET";
      sendSuccess(res, withCatalog(await engine.getState()));
      return;
    }

    if (!isJsonContentType(req)) {
      sendFailure(res, 415, "INVALID_INPUT", "POST requests must use content-type application/json.");
      return;
    }

    let raw;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (error) {
      if (error?.code === "BODY_TOO_LARGE") {
        sendFailure(res, 413, "INVALID_INPUT", `Request body exceeds the ${MAX_BODY_BYTES}-byte limit.`);
      } else {
        sendFailure(res, 400, "INVALID_INPUT", "The request body could not be read.");
      }
      return;
    }

    let request;
    try {
      request = raw.trim().length === 0 ? {} : JSON.parse(raw);
    } catch {
      sendFailure(res, 400, "INVALID_INPUT", "The request body must be valid JSON.");
      return;
    }
    if (!isRecord(request)) {
      sendFailure(res, 400, "INVALID_INPUT", "The request body must be a JSON object.");
      return;
    }
    if (typeof request.action !== "string" || request.action.length === 0) {
      sendFailure(res, 400, "INVALID_INPUT", "The request body must include a non-empty action.");
      return;
    }
    if (request.payload !== undefined && !isRecord(request.payload)) {
      sendFailure(res, 400, "INVALID_INPUT", "The request payload must be a JSON object.");
      return;
    }

    action = request.action;
    const payload = request.payload === undefined ? {} : request.payload;
    const value = await dispatch(engine, action, payload);
    sendSuccess(res, value);
  } catch (error) {
    const failure = failureOf(error);
    if (failure.code === "UNKNOWN") reportFailure(ctx, action, failure);
    sendFailure(res, failure.status, failure.code, failure.message, failure.details);
  }
}

/**
 * Register the settings API route.
 *
 * @param ctx - context carrying the web server service.
 * @param engine - shared her-memory engine.
 * @returns the effect disposer that removes the route.
 */
export function registerApi(ctx, engine) {
  return ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: API_PATH,
    handler: (req, res) => handleRequest(ctx, engine, req, res)
  }), "her-memory: settings API");
}
