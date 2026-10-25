/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- This is the untrusted SDK event parsing boundary. Validate nested values before applying the outbound allowlist. */
/** Error telemetry must never include account, request, file, or browsing data. */
const EXPECTED_CODES = new Set([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "UNPROCESSABLE_CONTENT",
  "TOO_MANY_REQUESTS",
  "CLIENT_CLOSED_REQUEST",
]);

const EVENT_FIELDS = new Set([
  "event_id",
  "timestamp",
  "platform",
  "release",
  "dist",
  "environment",
  "sdk",
  "level",
  "exception",
  "threads",
  "debug_meta",
  "contexts",
  "tags",
  "user",
]);
const FRAME_FIELDS = new Set([
  "filename",
  "abs_path",
  "function",
  "raw_function",
  "module",
  "package",
  "lineno",
  "colno",
  "in_app",
  "instruction_addr",
  "symbol_addr",
  "image_addr",
  "addr_mode",
  "platform",
  "trust",
]);
const CONTEXT_FIELDS = new Map<string, readonly string[]>([
  ["app", ["type", "app_identifier", "app_version", "app_build", "in_foreground"]],
  ["os", ["type", "name", "version", "build", "kernel_version", "rooted"]],
  ["runtime", ["type", "name", "version"]],
  ["device", ["type", "arch", "family", "model", "model_id", "brand", "manufacturer", "simulator", "memory_size"]],
  ["browser", ["type", "name", "version"]],
  ["react_native_context", ["react_native_version", "hermes_version", "js_engine", "fabric", "turbo_module"]],
]);

function record(value: unknown): Record<string, unknown> | undefined {
  // SAFETY: only non-null, non-array objects enter the dictionary branch; every nested value is checked before use.
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function errorCode(error: unknown): string | undefined {
  const object = record(error);
  const candidate = record(object?.data)?.code ?? object?.code;
  return typeof candidate === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(candidate) ? candidate : undefined;
}

export function shouldReportError(error: unknown): boolean {
  const object = record(error);
  if (["AbortError", "CanceledError", "CancelledError"].includes(String(object?.name))) {
    return false;
  }
  const code = errorCode(error);
  return !code || !EXPECTED_CODES.has(code);
}

export function errorOperation(operation: string | undefined): string {
  return operation && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/u.test(operation) ? operation : "unknown";
}

/** Keep compiler/runtime diagnostics; application messages can contain private server responses or input. */
function diagnosticMessage(value: unknown, type: unknown): string {
  const message = typeof value === "string" ? value : "";
  if (/^Cannot (?:read|set) propert(?:y|ies)/u.test(message)) {
    return "Cannot access a property of a missing value";
  }
  if (/^(?:null|undefined) is not/u.test(message)) {
    return "Null or undefined value used unexpectedly";
  }
  if (/^[A-Za-z_$][\w$]* is not a function/u.test(message)) {
    return "Value is not a function";
  }
  if (/^[A-Za-z_$][\w$]* is not defined/u.test(message)) {
    return "Variable is not defined";
  }
  if (message.startsWith("Maximum call stack size exceeded")) {
    return "Maximum call stack size exceeded";
  }
  if (message.startsWith("Too many re-renders")) {
    return "Too many re-renders";
  }
  if (/^Rendered (?:more|fewer) hooks/u.test(message)) {
    return "React hook order changed";
  }
  const reactCode = /^Minified React error #(\d{1,4})/u.exec(message)?.[1];
  if (reactCode) {
    return `Minified React error #${reactCode}`;
  }
  if (["Network request failed", "Failed to fetch", "Load failed", "fetch failed"].includes(message)) {
    return "Network request failed";
  }
  const name = typeof type === "string" && /^[A-Za-z_$][\w.$]{0,79}$/u.test(type) ? type : "Error";
  return `${name}: application error (details omitted)`;
}

function sourceLocation(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  return value
    .replace(/[?#].*$/u, "")
    .replace(/(\/Users\/|\/home\/)[^/]+\//gu, "$1[redacted]/")
    .replace(/([A-Za-z]:\\Users\\)[^\\]+\\/gu, "$1[redacted]\\")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gu, "$1")
    .slice(0, 600);
}

function sanitizeStack(stack: unknown): void {
  const object = record(stack);
  if (!object) {
    return;
  }
  for (const key of Object.keys(object)) {
    if (key !== "frames") {
      delete object[key];
    }
  }
  if (!Array.isArray(object.frames)) {
    return;
  }
  object.frames = object.frames.slice(-80).map((frame: unknown) => {
    const result = record(frame) ?? {};
    for (const key of Object.keys(result)) {
      if (!FRAME_FIELDS.has(key)) {
        delete result[key];
      } else if (["filename", "abs_path", "package"].includes(key)) {
        result[key] = sourceLocation(result[key]);
      } else if (typeof result[key] === "string") {
        // SAFETY: the enclosing branch verified this field is a string.
        result[key] = (result[key] as string).slice(0, 300);
      }
    }
    return result;
  });
}

/** Allowlist the outbound event, keeping stack addresses/debug IDs for symbolication. */
export function sanitizeErrorEvent<T extends object>(event: T): T {
  // SAFETY: the SDK event is an object; all dynamic fields are validated and allowlisted below.
  const output = event as Record<string, unknown>;
  for (const key of Object.keys(output)) {
    if (!EVENT_FIELDS.has(key)) {
      delete output[key];
    }
  }
  // An explicit sentinel prevents collectors from inferring a stored user IP from transport.
  output.user = { ip_address: "0.0.0.0" };
  const exceptions = record(output.exception);
  if (Array.isArray(exceptions?.values)) {
    exceptions.values = exceptions.values.slice(-8).map((value: unknown) => {
      const exception = record(value) ?? {};
      for (const key of Object.keys(exception)) {
        if (!["type", "value", "stacktrace", "mechanism", "module"].includes(key)) {
          delete exception[key];
        }
      }
      exception.value = diagnosticMessage(exception.value, exception.type);
      if (typeof exception.type !== "string" || !/^[A-Za-z_$][\w.$]{0,79}$/u.test(exception.type)) {
        exception.type = "Error";
      }
      sanitizeStack(exception.stacktrace);
      const mechanism = record(exception.mechanism);
      if (mechanism) {
        for (const key of Object.keys(mechanism)) {
          if (!["type", "handled", "synthetic", "is_exception_group", "exception_id", "parent_id"].includes(key)) {
            delete mechanism[key];
          }
        }
      }
      return exception;
    });
  }
  const threads = record(output.threads);
  if (Array.isArray(threads?.values)) {
    threads.values = threads.values.slice(0, 32).map((value: unknown) => {
      const thread = record(value) ?? {};
      for (const key of Object.keys(thread)) {
        if (!["id", "crashed", "current", "stacktrace"].includes(key)) {
          delete thread[key];
        }
      }
      sanitizeStack(thread.stacktrace);
      return thread;
    });
  }
  const contexts = record(output.contexts);
  if (contexts) {
    for (const [name, context] of Object.entries(contexts)) {
      const allowed = CONTEXT_FIELDS.get(name);
      const fields = record(context);
      if (!allowed || !fields) {
        delete contexts[name];
        continue;
      }
      const allowedFields = new Set(allowed);
      for (const key of Object.keys(fields)) {
        if (!allowedFields.has(key)) {
          delete fields[key];
        }
      }
    }
  }
  const tags = record(output.tags);
  if (tags) {
    for (const key of Object.keys(tags)) {
      if (!["surface", "operation", "error_code"].includes(key)) {
        delete tags[key];
      } else {
        // SAFETY: the conditional checks this tag is a string before passing it to the validator.
        tags[key] = errorOperation(typeof tags[key] === "string" ? (tags[key] as string) : undefined);
      }
    }
  }
  const debug = record(output.debug_meta);
  if (Array.isArray(debug?.images)) {
    for (const image of debug.images) {
      const fields = record(image);
      if (!fields) {
        continue;
      }
      for (const key of ["code_file", "debug_file"]) {
        if (key in fields) {
          fields[key] = sourceLocation(fields[key]);
        }
      }
    }
  }
  return event;
}
