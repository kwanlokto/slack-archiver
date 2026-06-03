/**
 * Self-initializing logger + crash handler. Importing this module FIRST
 * (before anything that could throw at require-time, like better-sqlite3)
 * guarantees we capture import-time crashes in the log file and pause the
 * console window long enough for the user to read them.
 */
import * as fs from "fs";
import { resolveAppPath } from "./paths";

export const logPath = resolveAppPath("slack-archiver.log");

let stream: fs.WriteStream | null = null;
try {
  stream = fs.createWriteStream(logPath, { flags: "a" });
  stream.on("error", (err) => {
    process.stderr.write(`[logger] write error: ${err.message}\n`);
  });
  stream.write(`\n=========== started ${new Date().toISOString()} pid=${process.pid} ===========\n`);
  stream.write(`exe: ${process.execPath}\n`);
  stream.write(`argv: ${JSON.stringify(process.argv)}\n`);
  stream.write(`cwd: ${process.cwd()}\n`);
} catch (err) {
  process.stderr.write(`[logger] failed to open ${logPath}: ${(err as Error).message}\n`);
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

const wrap = (orig: (...args: unknown[]) => void, level: string) => {
  return (...args: unknown[]) => {
    try {
      orig(...args);
    } catch {
      /* ignore — console may be closed */
    }
    if (!stream) return;
    const line = args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ");
    try {
      stream.write(`[${new Date().toISOString()}] ${level} ${line}\n`);
    } catch {
      /* ignore */
    }
  };
};

console.log = wrap(console.log.bind(console), "INFO ");
console.warn = wrap(console.warn.bind(console), "WARN ");
console.error = wrap(console.error.bind(console), "ERROR");

/** Keep the console window open if the user double-clicked the .exe. */
export async function pauseIfInteractive(): Promise<void> {
  if (!process.stdin.isTTY) return;
  process.stderr.write("\nPress Enter to exit…\n");
  await new Promise<void>((resolve) => {
    try {
      process.stdin.resume();
      process.stdin.once("data", () => resolve());
    } catch {
      resolve();
    }
  });
}

process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err);
  console.error(`[fatal] full log: ${logPath}`);
  void pauseIfInteractive().finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection:", reason);
  console.error(`[fatal] full log: ${logPath}`);
  void pauseIfInteractive().finally(() => process.exit(1));
});
