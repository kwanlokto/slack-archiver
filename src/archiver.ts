import type { Store, Channel } from "./db";
import type { SlackClient } from "./slack";

export interface ExtractionResult {
  channel: string;
  fetched: number;
  inserted: number;
  threadReplies: number;
  latestTs: string | null;
}

/**
 * Pull new messages for a single channel, starting from its last archived ts.
 * Inserts incrementally and updates the channel watermark only after each page
 * succeeds — so a failure mid-run resumes from the most recent persisted ts.
 */
export async function extractChannel(
  slack: SlackClient,
  store: Store,
  channel: Channel,
): Promise<ExtractionResult> {
  let fetched = 0;
  let inserted = 0;
  let threadReplies = 0;
  let latestTs: string | null = channel.last_message_ts;

  for await (const page of slack.fetchHistory(channel.slack_id, channel.last_message_ts)) {
    fetched += page.length;
    const result = store.insertMessages(channel.id, page);
    inserted += result.inserted;
    if (result.latestTs && (!latestTs || parseFloat(result.latestTs) > parseFloat(latestTs))) {
      latestTs = result.latestTs;
    }

    // Pull thread replies for any parent messages on this page that have a reply count.
    const threadParents = page.filter(
      (m) => typeof m.reply_count === "number" && (m.reply_count as number) > 0 && !m.thread_ts,
    );
    for (const parent of threadParents) {
      const replies = await slack.fetchThread(channel.slack_id, parent.ts);
      if (replies.length > 0) {
        const r = store.insertMessages(channel.id, replies);
        threadReplies += r.inserted;
      }
    }

    if (latestTs) store.updateLastMessageTs(channel.id, latestTs);
  }

  return {
    channel: channel.name,
    fetched,
    inserted,
    threadReplies,
    latestTs,
  };
}

export async function extractAll(slack: SlackClient, store: Store): Promise<ExtractionResult[]> {
  const channels = store.listEnabledChannels();
  const results: ExtractionResult[] = [];
  for (const ch of channels) {
    try {
      const r = await extractChannel(slack, store, ch);
      results.push(r);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ channel: ch.name, fetched: 0, inserted: 0, threadReplies: 0, latestTs: ch.last_message_ts });
      console.error(`[archiver] extract failed for #${ch.name}: ${msg}`);
    }
  }
  return results;
}
