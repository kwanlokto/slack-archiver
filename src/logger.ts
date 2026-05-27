import * as fs from "fs";
import { resolveAppPath } from "./paths";

let stream: fs.WriteStream | null = null;

/**
 * Mirror stdout/stderr to a file next to the exe so the user can read what
 * happened after a packaged .exe closes its window. Idempotent.
 */
export function initFileLogger(filename = "slack-archiver.log"): string {
  if (stream) return (stream.path as string);
  const logPath = resolveAppPath(filename);

  stream = fs.createWriteStream(logPath, { flags: "a" });
  stream.write(`\n=========== started ${new Date().toISOString()} ===========\n`);

  const wrap = (orig: (...args: unknown[]) => void, level: string) => {
    return (...args: unknown[]) => {
      orig(...args);
      const line = args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ");
      stream!.write(`[${new Date().toISOString()}] ${level} ${line}\n`);
    };
  };

  console.log = wrap(console.log.bind(console), "INFO ");
  console.warn = wrap(console.warn.bind(console), "WARN ");
  console.error = wrap(console.error.bind(console), "ERROR");

  return logPath;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, errorReplacer);
  } catch {
    return String(v);
  }
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}
