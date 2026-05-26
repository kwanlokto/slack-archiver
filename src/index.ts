import { loadConfig } from "./config";
import { Store } from "./db";
import { CredentialsStore } from "./credentials";
import { Runtime } from "./runtime";
import { createServer } from "./api/server";

async function main(): Promise<void> {
  const cfg = loadConfig();
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

main().catch((err) => {
  console.error("[main] fatal:", err);
  process.exit(1);
});
