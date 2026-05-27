import * as path from "path";

/**
 * When pkg packages a Node app into a single .exe, the file system the JS sees
 * (`__dirname`, `process.cwd()`) is the snapshot inside the binary, NOT the
 * directory the user dropped the .exe in. We need the latter for the user's
 * `.env`, `data/`, logs, and exports.
 *
 * `process.pkg` is set by pkg at runtime, so we use it to detect packaged mode.
 */
const isPackaged = Boolean((process as unknown as { pkg?: unknown }).pkg);

/** Directory the user perceives as "where the app lives". */
export function appDir(): string {
  if (isPackaged) {
    return path.dirname(process.execPath);
  }
  return process.cwd();
}

/** Resolve a relative path against {@link appDir}; pass-through for absolute paths. */
export function resolveAppPath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(appDir(), p);
}

export { isPackaged };
