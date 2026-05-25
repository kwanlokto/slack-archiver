#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config";
import { Store } from "./db";
import { SlackClient } from "./slack";
import { verifyOwner } from "./auth";
import { extractAll, extractChannel } from "./archiver";
import { exportChannel, ExportFormat } from "./exporter";

const program = new Command();
program.name("slack-archiver").description("Archive Slack channels to SQLite").version("0.1.0");

async function withDeps(): Promise<{ slack: SlackClient; store: Store }> {
  const cfg = loadConfig();
  const slack = new SlackClient(cfg.slackToken);
  const store = new Store(cfg.dbPath);
  const owner = await verifyOwner(slack);
  if (!owner.ok) {
    console.error(`Token belongs to @${owner.user} who is not a workspace owner. Aborting.`);
    process.exit(1);
  }
  return { slack, store };
}

program
  .command("verify")
  .description("Check Slack token and owner status")
  .action(async () => {
    const cfg = loadConfig();
    const slack = new SlackClient(cfg.slackToken);
    const owner = await verifyOwner(slack);
    console.log(JSON.stringify(owner, null, 2));
    if (!owner.ok) process.exit(1);
  });

program
  .command("add-channel <channel>")
  .description("Add a channel to the archive list (ID like C0123 or name like #general)")
  .action(async (ref: string) => {
    const { slack, store } = await withDeps();
    const info = await slack.resolveChannel(ref);
    const ch = store.addChannel(info.id, info.name, info.is_private);
    console.log(`Added #${ch.name} (${ch.slack_id})${ch.is_private ? " [private]" : ""}`);
  });

program
  .command("remove-channel <channel>")
  .description("Remove a channel and its archived messages (irreversible)")
  .action(async (ref: string) => {
    const { store } = await withDeps();
    const existing = store.getChannelBySlackId(ref) ?? store.getChannelByName(ref);
    if (!existing) {
      console.error(`Not archived: ${ref}`);
      process.exit(1);
    }
    store.removeChannel(existing.slack_id);
    console.log(`Removed #${existing.name} and all of its messages`);
  });

program
  .command("list-channels")
  .description("Show all archived channels with counts")
  .action(async () => {
    const cfg = loadConfig();
    const store = new Store(cfg.dbPath);
    const channels = store.listChannels();
    if (channels.length === 0) {
      console.log("(no channels — use `add-channel` first)");
      return;
    }
    for (const c of channels) {
      const count = store.countMessages(c.id);
      const status = c.enabled ? "on" : "off";
      const last = c.last_message_ts
        ? new Date(parseFloat(c.last_message_ts) * 1000).toISOString()
        : "never";
      console.log(`  [${status}] #${c.name.padEnd(24)} ${String(count).padStart(7)} msgs  last=${last}`);
    }
  });

program
  .command("enable <channel>")
  .description("Re-enable scheduling for a channel")
  .action(async (ref: string) => {
    const { store } = await withDeps();
    const existing = store.getChannelBySlackId(ref) ?? store.getChannelByName(ref);
    if (!existing) { console.error(`Not archived: ${ref}`); process.exit(1); }
    store.setChannelEnabled(existing.slack_id, true);
    console.log(`Enabled #${existing.name}`);
  });

program
  .command("disable <channel>")
  .description("Pause scheduling for a channel (messages kept)")
  .action(async (ref: string) => {
    const { store } = await withDeps();
    const existing = store.getChannelBySlackId(ref) ?? store.getChannelByName(ref);
    if (!existing) { console.error(`Not archived: ${ref}`); process.exit(1); }
    store.setChannelEnabled(existing.slack_id, false);
    console.log(`Disabled #${existing.name}`);
  });

program
  .command("extract [channel]")
  .description("Run one extraction pass (all enabled channels, or just the given one)")
  .action(async (ref?: string) => {
    const { slack, store } = await withDeps();
    if (ref) {
      const ch = store.getChannelBySlackId(ref) ?? store.getChannelByName(ref);
      if (!ch) { console.error(`Not archived: ${ref}`); process.exit(1); }
      const r = await extractChannel(slack, store, ch);
      console.log(`#${r.channel}: fetched ${r.fetched}, inserted ${r.inserted} (+${r.threadReplies} thread replies)`);
    } else {
      const results = await extractAll(slack, store);
      for (const r of results) {
        console.log(`#${r.channel}: fetched ${r.fetched}, inserted ${r.inserted} (+${r.threadReplies} thread replies)`);
      }
    }
  });

program
  .command("export <channel>")
  .description("Export an archived channel to a file in EXPORT_DIR")
  .option("-f, --format <fmt>", "json | jsonl | csv | txt", "jsonl")
  .action(async (ref: string, opts: { format: string }) => {
    const cfg = loadConfig();
    const store = new Store(cfg.dbPath);
    const ch = store.getChannelBySlackId(ref) ?? store.getChannelByName(ref);
    if (!ch) { console.error(`Not archived: ${ref}`); process.exit(1); }
    const fmt = opts.format as ExportFormat;
    if (!["json", "jsonl", "csv", "txt"].includes(fmt)) {
      console.error(`Invalid format: ${fmt}`); process.exit(1);
    }
    const r = exportChannel(store, ch, cfg.exportDir, fmt);
    console.log(`Exported ${r.messageCount} messages → ${r.path}`);
  });

program.parseAsync().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
