/**
 * Host plugin entry point.
 *
 * The plugin owns one engine per activation and attaches it to whichever
 * optional host services are present: tools, skills, the system prompt, and
 * the web server. None of those services is a hard dependency, so the plugin
 * activates in a plain host composition and simply contributes fewer surfaces.
 *
 * @module @local/dsh-her-memory
 */

import { createEngine } from "./lib/engine.js";
import { registerTools } from "./lib/tools.js";
import { registerSkills } from "./lib/skills.js";
import { registerPrompt } from "./lib/prompt.js";
import { registerApi } from "./lib/api.js";

/** Stable plugin name used by the loader and diagnostics. */
export const name = "her-memory";

/** Delay before the one-shot automatic maintenance check. */
const AUTO_MAINTENANCE_DELAY_MS = 3000;

/** Whether a value behaves like a promise. */
function isThenable(value) {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof value.then === "function";
}

/** Write one diagnostic line through the host logger, with a safe fallback. */
function log(ctx, level, message, error) {
  const detail = error instanceof Error ? error.message : (error === undefined ? "" : String(error));
  const text = detail.length > 0 ? `${message}: ${detail}` : message;
  const logger = ctx?.logger;
  if (logger !== undefined && logger !== null && typeof logger[level] === "function") {
    logger[level](text);
    return;
  }
  if (level === "error") {
    if (typeof console !== "undefined" && typeof console.error === "function") console.error(text);
  } else if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(text);
  }
}

/** Start engine initialization without blocking activation. */
function startEngine(ctx, engine) {
  if (engine === null || typeof engine !== "object" || typeof engine.init !== "function") return;
  const report = (error) => log(ctx, "error", "[her-memory] initialization failed", error);
  let result;
  try {
    result = engine.init();
  } catch (error) {
    report(error);
    return;
  }
  if (isThenable(result)) result.catch(report);
  if (isThenable(engine.ready) && engine.ready !== result) engine.ready.catch(report);
}

/** Read an explicit maintenance-due flag from the engine state, when present. */
function maintenanceDue(state) {
  if (state === null || typeof state !== "object") return undefined;
  for (const candidate of [state.maintenanceDue, state.maintenance?.due, state.status?.maintenanceDue, state.status?.maintenance?.due]) {
    if (typeof candidate === "boolean") return candidate;
  }
  const nextAt = state.nextMaintenanceAt
    ?? state.maintenance?.nextAt
    ?? state.maintenance?.nextRunAt
    ?? state.status?.nextMaintenanceAt;
  if (typeof nextAt === "string" || typeof nextAt === "number") {
    const time = typeof nextAt === "number" ? nextAt : Date.parse(nextAt);
    if (Number.isFinite(time)) return Date.now() >= time;
  }
  return undefined;
}

/** Decide whether automatic maintenance is due, without assuming a state shape. */
async function checkMaintenanceDue(engine) {
  if (typeof engine?.isMaintenanceDue === "function") {
    const value = await engine.isMaintenanceDue();
    if (typeof value === "boolean") return value;
  }
  if (typeof engine?.getState !== "function") return undefined;
  const state = await engine.getState();
  return maintenanceDue(state);
}

/** Run the engine's preferred automatic maintenance entry point. */
async function runAutoMaintenance(engine) {
  if (engine === null || typeof engine !== "object") return undefined;
  if (typeof engine.maybeAutoMaintain === "function") return engine.maybeAutoMaintain();
  const due = await checkMaintenanceDue(engine);
  if (due === false) return undefined;
  if (typeof engine.maintain === "function") return engine.maintain();
  return undefined;
}

/** Schedule one maintenance check after activation, cleaned up on dispose. */
function scheduleAutoMaintenance(ctx, engine, config) {
  if (config?.maintenance?.autoRun === false) return;
  const task = () => {
    Promise.resolve()
      .then(() => runAutoMaintenance(engine))
      .catch((error) => log(ctx, "warn", "[her-memory] automatic maintenance failed", error));
  };
  try {
    if (typeof ctx.setTimeout === "function") {
      ctx.setTimeout(task, AUTO_MAINTENANCE_DELAY_MS);
      return;
    }
    if (typeof ctx.timeout === "function") {
      ctx.timeout(task, AUTO_MAINTENANCE_DELAY_MS);
      return;
    }
    if (typeof setTimeout === "function") {
      const timer = setTimeout(task, AUTO_MAINTENANCE_DELAY_MS);
      if (typeof timer?.unref === "function") timer.unref();
      if (typeof ctx.effect === "function") {
        ctx.effect(() => () => clearTimeout(timer), "her-memory: automatic maintenance timer");
      }
    }
  } catch (error) {
    log(ctx, "warn", "[her-memory] could not schedule automatic maintenance", error);
  }
}

/**
 * Activate the plugin.
 *
 * @param ctx - host plugin context.
 * @param config - plugin row config, merged by the engine with its defaults.
 */
export function apply(ctx, config = {}) {
  const engine = createEngine({ ctx, config, logger: ctx.logger });

  startEngine(ctx, engine);

  try {
    if (typeof ctx.provide === "function") {
      ctx.provide("herMemory", engine.api ?? engine);
    }
  } catch (error) {
    log(ctx, "warn", "[her-memory] could not provide the herMemory service", error);
  }

  if (typeof ctx.inject === "function") {
    ctx.inject(["tools"], (injected) => registerTools(injected, engine));
    ctx.inject(["skills"], (injected) => registerSkills(injected, engine));
    ctx.inject(["systemPrompt"], (injected) => registerPrompt(injected));
    ctx.inject(["webServer"], (injected) => registerApi(injected, engine));
  }

  scheduleAutoMaintenance(ctx, engine, config);
}
