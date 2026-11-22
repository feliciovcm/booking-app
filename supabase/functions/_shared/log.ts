// Structured logging for edge functions: one JSON object per line, tagged with the
// function name and a request id, with personal data kept out.

export type Fields = Record<string, string | number | boolean | null | undefined>;
export type Sink = Pick<Console, "log" | "warn" | "error">;
type Level = "info" | "warn" | "error";

// Keys whose values must never reach the logs (compared lowercase, without _ or -).
const REDACTED_KEYS = new Set([
  "email", "phone", "phonenumber", "name", "firstname", "lastname", "fullname", "address",
  "token", "accesstoken", "authorization", "password", "secret", "clientsecret",
]);
const RESERVED_KEYS = new Set(["level", "fn", "requestId", "msg"]);

const normalize = (key: string) => key.toLowerCase().replace(/[_-]/g, "");

/** Reuses the caller's x-request-id so one id follows a request across services. */
export function requestIdFrom(req: Request): string {
  const incoming = req.headers.get("x-request-id");
  return incoming && /^[\w.-]{1,128}$/.test(incoming) ? incoming : crypto.randomUUID();
}

export function createLogger(fn: string, requestId: string, sink: Sink = console) {
  const write = (level: Level, msg: string, fields: Fields = {}) => {
    const entry: Record<string, unknown> = { level, fn, requestId, msg };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || RESERVED_KEYS.has(key)) continue;
      entry[key] = REDACTED_KEYS.has(normalize(key)) ? "[redacted]" : value;
    }
    const line = JSON.stringify(entry);
    if (level === "error") sink.error(line);
    else if (level === "warn") sink.warn(line);
    else sink.log(line);
  };

  return {
    requestId,
    info: (msg: string, fields?: Fields) => write("info", msg, fields),
    warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
    error: (msg: string, fields?: Fields) => write("error", msg, fields),
  };
}

export type Log = ReturnType<typeof createLogger>;

/**
 * Runs an async step and logs how long it took and whether it worked. Rethrows errors.
 * Logs the error's name and code, not its message: messages can carry personal data
 * (e.g. "Invalid PhoneNumber: +1212..."), so log a safe message yourself if needed.
 */
export async function timed<T>(log: Log, msg: string, run: () => Promise<T>, fields: Fields = {}): Promise<T> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const result = await run();
    log.info(msg, { ...fields, ok: true, ms: ms() });
    return result;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    log.error(msg, {
      ...fields,
      ok: false,
      ms: ms(),
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: typeof code === "string" ? code : undefined,
    });
    throw error;
  }
}
