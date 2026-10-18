/**
 * Typed errors for the her.memory host core.
 *
 * Every public subsystem throws {@link HermemoryError} so that the tool layer and
 * the Web API can turn a failure into a stable `{ code, message, status, details }`
 * envelope. Unknown failures are wrapped by {@link toError} instead of leaking
 * stack traces or runtime-specific error classes.
 *
 * @module errors
 */

/** Stable error codes shared with the tools, API, and settings page. */
export const ERROR_CODES = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  STORE_LOCKED: "STORE_LOCKED",
  STORE_IO: "STORE_IO",
  NOT_FOUND: "NOT_FOUND",
  DUPLICATE: "DUPLICATE",
  BACKEND_UNAVAILABLE: "BACKEND_UNAVAILABLE",
  EMBEDDING_FAILED: "EMBEDDING_FAILED",
  CHAT_FAILED: "CHAT_FAILED",
  PROPOSAL_NOT_FOUND: "PROPOSAL_NOT_FOUND",
  PROPOSAL_NOT_EXECUTED: "PROPOSAL_NOT_EXECUTED",
  SNAPSHOT_NOT_FOUND: "SNAPSHOT_NOT_FOUND",
  IMPORT_INVALID: "IMPORT_INVALID",
  EXPORT_TOO_LARGE: "EXPORT_TOO_LARGE",
  UNKNOWN: "UNKNOWN",
});

/**
 * Error type used across the plugin.
 *
 * @example
 * throw new HermemoryError("NOT_FOUND", "memory not found", { status: 404, details: { id } });
 */
export class HermemoryError extends Error {
  /**
   * @param {string|object} code Error code, or an options object.
   * @param {string} [message] Human-readable message.
   * @param {object} [options] Additional fields.
   * @param {number} [options.status=400] HTTP-ish status used by the API.
   * @param {*} [options.details=null] Structured, JSON-serializable details.
   * @param {Error} [options.cause] Original error, when wrapping.
   */
  constructor(code, message, options = {}) {
    let resolvedCode = code;
    let resolvedMessage = message;
    let resolvedOptions = options;

    if (code && typeof code === "object") {
      resolvedOptions = code;
      resolvedCode = code.code;
      resolvedMessage = code.message;
    }

    const codeValue =
      typeof resolvedCode === "string" && resolvedCode ? resolvedCode : ERROR_CODES.UNKNOWN;
    const messageValue =
      typeof resolvedMessage === "string" && resolvedMessage
        ? resolvedMessage
        : codeValue;

    super(messageValue);

    /** @type {string} */
    this.name = "HermemoryError";
    /** @type {string} */
    this.code = codeValue;
    /** @type {number} */
    this.status =
      Number.isInteger(resolvedOptions.status) && resolvedOptions.status > 0
        ? resolvedOptions.status
        : 400;
    /** @type {*} */
    this.details =
      resolvedOptions.details === undefined ? null : resolvedOptions.details;

    if (resolvedOptions.cause !== undefined) {
      this.cause = resolvedOptions.cause;
    }

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, HermemoryError);
    }
  }

  /**
   * Convert the error into a JSON-safe envelope.
   *
   * @returns {{code: string, message: string, status: number, details: *}}
   */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      details: this.details,
    };
  }
}

/**
 * Normalize any thrown value into a {@link HermemoryError}.
 *
 * Existing HermemoryError instances are returned unchanged. Anything else is
 * wrapped as `UNKNOWN` with status 500 while preserving the original message.
 *
 * @param {*} error Thrown value.
 * @returns {HermemoryError}
 */
export function toError(error) {
  if (error instanceof HermemoryError) {
    return error;
  }

  if (error instanceof Error) {
    const wrapped = new HermemoryError(
      ERROR_CODES.UNKNOWN,
      error.message || String(error),
      { status: 500, details: { name: error.name }, cause: error },
    );
    if (error.stack) {
      wrapped.stack = error.stack;
    }
    return wrapped;
  }

  const message = typeof error === "string" ? error : String(error);
  return new HermemoryError(ERROR_CODES.UNKNOWN, message || "Unknown error", {
    status: 500,
  });
}
