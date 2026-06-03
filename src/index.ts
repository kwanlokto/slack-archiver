// MUST be the first import — initializes the file logger and process-level
// crash handlers BEFORE any other module is loaded. That way an import-time
// crash (e.g. better-sqlite3 native binding fails to load) still ends up in
// slack-archiver.log instead of disappearing with the console window.
import { logPath, pauseIfInteractive } from "./logger";

import { loadConfig } from "./config";
import { Store } from "./db";
import { CredentialsStore } from "./credentials";
import { Runtime } from "./runtime";
import { createServer } from "./api/server";
import { isPackaged, appDir } from "./paths";

async function startDaemon(): Promise<void> {
  console.log(`[startup] slack-archiver booting`);
  console.log(`[startup] app dir: ${appDir()}`);
  console.log(`[startup] log file: ${logPath}`);
  console.log(`[startup] packaged: ${isPackaged}`);

  const cfg = loadConfig();
  console.log(`[startup] db: ${cfg.dbPath}`);
  console.log(`[startup] credentials: ${cfg.credentialsPath}`);

  const store = new Store(cfg.dbPath);
  const credentials = new CredentialsStore(cfg.credentialsPath);
  const runtime = new Runtime(cfg, store, credentials);

  await runtime.initialize();
  logStartupStatus(runtime);

  const isLoopback = cfg.apiHost === "127.0.0.1" || cfg.apiHost === "localhost" || cfg.apiHost === "::1";
  if (!isLoopback) {
    console.warn(
      `[startup] WARNING: API_HOST=${cfg.apiHost} is not loopback. The API has no built-in auth — ` +
        `put a reverse proxy with auth in front, or bind to 127.0.0.1.`,
    );
  }

  const app = createServer(runtime);
  const server = app.listen(cfg.apiPort, cfg.apiHost, () => {
    console.log(`[api] listening on http://${cfg.apiHost}:${cfg.apiPort}`);
    if (runtime.status.state !== "ready") {
      console.log(`[api] open http://${cfg.apiHost}:${cfg.apiPort}/setup.html to finish setup`);
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[api] port ${cfg.apiPort} is already in use. Another copy of slack-archiver may be running, ` +
          `or another app is bound to that port. Close it (Ctrl+Shift+Esc → find node.exe / slack-archiver.exe) or set API_PORT in .env.`,
      );
    } else {
      console.error("[api] server error:", err);
    }
    void pauseIfInteractive().finally(() => process.exit(1));
  });

  const shutdown = (signal: string) => {
    console.log(`\n[main] ${signal} received — shutting down`);
    runtime.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function logStartupStatus(runtime: Runtime): void {
  const s = runtime.status;
  switch (s.state) {
    case "ready":
      console.log(`[startup] active as @${s.user} (${s.team})`);
      break;
    case "not_owner":
      console.warn(`[startup] @${s.user} in ${s.team} is not a workspace owner — scheduler not started`);
      break;
    case "error":
      console.error(`[startup] activation error: ${s.message}`);
      break;
    case "unconfigured":
      console.log("[startup] not configured yet — visit /setup.html to begin");
      break;
  }
}

// Dual-mode entry: if invoked with a known CLI subcommand or version/help
// flag, hand off to commander; otherwise start the daemon.
// We can't rely on `argv.length` because pkg's bootstrap injects extra
// internal entries into `process.argv` that aren't present under plain Node.
const CLI_SUBCOMMANDS = new Set([
  "verify",
  "add-channel",
  "remove-channel",
  "list-channels",
  "enable",
  "disable",
  "extract",
  "export",
  "help",
  "-h",
  "--help",
  "-V",
  "--version",
]);

if (process.argv.some((a) => CLI_SUBCOMMANDS.has(a))) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./cli");
} else {
  startDaemon().catch(async (err) => {
    console.error("[fatal] startup failed:", err);
    console.error(`[fatal] full log: ${logPath}`);
    await pauseIfInteractive();
    process.exit(1);
  });
}
