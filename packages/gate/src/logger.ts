import { pino } from "pino";

/**
 * Process-wide logger. NEVER log full action params at info level (CLAUDE.md / D12) — callers log
 * `params_hash` instead. Redaction here is a backstop in case a params object slips into a log.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["params", "*.params", "action.params", "req.headers.authorization"],
    censor: "[redacted]",
  },
});

export type Logger = typeof logger;
