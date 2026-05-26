import type { Config } from "./config";
import type { Store } from "./db";
import type { CredentialsStore } from "./credentials";
import { SlackClient } from "./slack";
import { Scheduler } from "./scheduler";
import { verifyOwner } from "./auth";

export type RuntimeStatus =
  | { state: "unconfigured"; message: string }
  | { state: "not_owner"; user: string; team: string; message: string }
  | { state: "error"; message: string }
  | { state: "ready"; user: string; team: string; userId: string };

/**
 * Owns the dynamic dependencies (Slack client, scheduler) that come and go
 * as the user signs in / disconnects through the wizard. The HTTP server
 * is built once against this Runtime instance and reads through it.
 */
export class Runtime {
  slack: SlackClient | null = null;
  scheduler: Scheduler | null = null;
  status: RuntimeStatus = { state: "unconfigured", message: "Open /setup to begin" };

  constructor(
    public readonly cfg: Config,
    public readonly store: Store,
    public readonly credentials: CredentialsStore,
  ) {}

  /** Try to bring the runtime up using whatever token is currently available. */
  async initialize(): Promise<void> {
    const token = this.credentials.getAccessToken() ?? this.cfg.envSlackToken;
    if (!token) {
      this.status = { state: "unconfigured", message: "Open /setup to begin" };
      return;
    }
    await this.activate(token);
  }

  /** Initialize Slack + scheduler with a fresh token, replacing anything already running. */
  async activate(token: string): Promise<void> {
    this.stop();
    const slack = new SlackClient(token);
    try {
      const owner = await verifyOwner(slack);
      if (!owner.ok) {
        this.status = {
          state: "not_owner",
          user: owner.user,
          team: owner.team,
          message: `@${owner.user} is not a workspace owner — archiving disabled`,
        };
        return;
      }
      this.slack = slack;
      this.scheduler = new Scheduler(slack, this.store, this.cfg.scheduleCron);
      this.scheduler.start();
      void this.scheduler.tick();
      this.status = { state: "ready", user: owner.user, team: owner.team, userId: owner.userId };
      console.log(`[runtime] active as @${owner.user} (${owner.team})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status = { state: "error", message };
      console.error(`[runtime] activation failed: ${message}`);
    }
  }

  disconnect(): void {
    this.stop();
    this.credentials.clearAuth();
    this.status = { state: "unconfigured", message: "Disconnected — paste a new token to reconnect" };
  }

  stop(): void {
    this.scheduler?.stop();
    this.scheduler = null;
    this.slack = null;
  }

  isReady(): boolean {
    return this.status.state === "ready" && this.slack !== null && this.scheduler !== null;
  }
}
