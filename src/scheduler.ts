import cron, { ScheduledTask } from "node-cron";
import { extractAll } from "./archiver";
import type { Store } from "./db";
import type { SlackClient } from "./slack";

export class Scheduler {
  private task: ScheduledTask | null = null;
  private running = false;

  constructor(
    private readonly slack: SlackClient,
    private readonly store: Store,
    private readonly cronExpr: string,
  ) {}

  start(): void {
    if (this.task) return;
    if (!cron.validate(this.cronExpr)) {
      throw new Error(`Invalid SCHEDULE_CRON expression: "${this.cronExpr}"`);
    }
    this.task = cron.schedule(this.cronExpr, () => void this.tick());
    console.log(`[scheduler] started (cron: ${this.cronExpr})`);
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  async tick(): Promise<void> {
    if (this.running) {
      console.log("[scheduler] previous tick still running — skipping");
      return;
    }
    this.running = true;
    const started = Date.now();
    try {
      const results = await extractAll(this.slack, this.store);
      const totalInserted = results.reduce((sum, r) => sum + r.inserted + r.threadReplies, 0);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`[scheduler] tick done in ${elapsed}s — ${totalInserted} new messages across ${results.length} channels`);
      for (const r of results) {
        if (r.inserted + r.threadReplies > 0) {
          console.log(`  #${r.channel}: +${r.inserted} (+${r.threadReplies} thread replies)`);
        }
      }
    } catch (err) {
      console.error("[scheduler] tick failed:", err);
    } finally {
      this.running = false;
    }
  }
}
