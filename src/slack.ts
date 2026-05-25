import { WebClient, ErrorCode } from "@slack/web-api";
import type { SlackRawMessage } from "./db";

export interface SlackChannelInfo {
  id: string;
  name: string;
  is_private: boolean;
}

export class SlackClient {
  private client: WebClient;

  constructor(token: string) {
    this.client = new WebClient(token, {
      retryConfig: { retries: 5, factor: 2, minTimeout: 1000, maxTimeout: 60_000 },
    });
  }

  async authTest(): Promise<{ user_id: string; team_id: string; user: string; team: string }> {
    const r = await this.client.auth.test();
    return {
      user_id: r.user_id as string,
      team_id: r.team_id as string,
      user: r.user as string,
      team: r.team as string,
    };
  }

  async isOwner(userId: string): Promise<{ isOwner: boolean; isPrimaryOwner: boolean }> {
    const r = await this.client.users.info({ user: userId });
    const u = r.user as { is_owner?: boolean; is_primary_owner?: boolean } | undefined;
    return {
      isOwner: Boolean(u?.is_owner),
      isPrimaryOwner: Boolean(u?.is_primary_owner),
    };
  }

  async resolveChannel(channelRef: string): Promise<SlackChannelInfo> {
    // Accept a channel ID (starts with C/G/D) or a name (with or without #)
    const ref = channelRef.trim();
    if (/^[CGD][A-Z0-9]{8,}$/.test(ref)) {
      const r = await this.client.conversations.info({ channel: ref });
      const c = r.channel as { id: string; name: string; is_private?: boolean };
      return { id: c.id, name: c.name, is_private: Boolean(c.is_private) };
    }

    const cleanName = ref.startsWith("#") ? ref.slice(1) : ref;
    let cursor: string | undefined;
    do {
      const r = await this.client.conversations.list({
        cursor,
        limit: 1000,
        types: "public_channel,private_channel",
        exclude_archived: false,
      });
      const channels = (r.channels ?? []) as { id: string; name: string; is_private?: boolean }[];
      const match = channels.find((c) => c.name === cleanName);
      if (match) return { id: match.id, name: match.name, is_private: Boolean(match.is_private) };
      cursor = (r.response_metadata?.next_cursor as string | undefined) || undefined;
    } while (cursor);

    throw new Error(`Channel "${channelRef}" not found in workspace.`);
  }

  /**
   * Fetch all messages newer than `oldest` (exclusive). Paginates and respects
   * Slack rate-limit headers via the SDK's built-in retry.
   */
  async *fetchHistory(channelId: string, oldest: string | null): AsyncGenerator<SlackRawMessage[]> {
    let cursor: string | undefined;
    do {
      try {
        const r = await this.client.conversations.history({
          channel: channelId,
          cursor,
          limit: 200,
          oldest: oldest ?? "0",
          inclusive: false,
        });
        const messages = (r.messages ?? []) as SlackRawMessage[];
        if (messages.length > 0) yield messages;
        cursor = r.has_more ? (r.response_metadata?.next_cursor as string | undefined) : undefined;
      } catch (err) {
        const e = err as { code?: string; data?: { error?: string } };
        if (e.code === ErrorCode.PlatformError && e.data?.error === "not_in_channel") {
          throw new Error(`Bot/user is not a member of channel ${channelId}. Invite the token's user with /invite first.`);
        }
        throw err;
      }
    } while (cursor);
  }

  /**
   * Fetch thread replies for a parent message ts. Used opportunistically to
   * capture replies that don't appear in conversations.history.
   */
  async fetchThread(channelId: string, threadTs: string): Promise<SlackRawMessage[]> {
    const out: SlackRawMessage[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        cursor,
        limit: 200,
      });
      const msgs = (r.messages ?? []) as SlackRawMessage[];
      for (const m of msgs) if (m.ts !== threadTs) out.push(m);
      cursor = r.has_more ? (r.response_metadata?.next_cursor as string | undefined) : undefined;
    } while (cursor);
    return out;
  }
}
