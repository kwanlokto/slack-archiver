import { loadConfig } from "./config";
import { Store } from "./db";
import { SlackClient } from "./slack";
import { Scheduler } from "./scheduler";
import { verifyOwner } from "./auth";
import { createServer } from "./api/server";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const slack = new SlackClient(cfg.slackToken);
  const store = new Store(cfg.dbPath);

  const owner = await verifyOwner(slack);
  if (!owner.ok) {
    console.error(
      `Refusing to start: token belongs to @${owner.user} in ${owner.team}, who is not a workspace owner. ` +
        `Only Workspace Owners may archive (is_owner=${owner.isOwner}, is_primary_owner=${owner.isPrimaryOwner}).`,
    );
    process.exit(1);
  }
  console.log(`[auth] running as @${owner.user} (${owner.team}) — owner verified`);

  const scheduler = new Scheduler(slack, store, cfg.scheduleCron);
  scheduler.start();

  // Kick off an immediate tick so a freshly-started daemon catches up right away
  // instead of waiting for the first scheduled fire.
  void scheduler.tick();

  const app = createServer({
    store,
    slack,
    scheduler,
    adminPassword: cfg.adminPassword,
    exportDir: cfg.exportDir,
  });

  const server = app.listen(cfg.apiPort, cfg.apiHost, () => {
    console.log(`[api] listening on http://${cfg.apiHost}:${cfg.apiPort}`);
  });

  const shutdown = (signal: string) => {
    console.log(`\n[main] ${signal} received — shutting down`);
    scheduler.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[main] fatal:", err);
  process.exit(1);
});
