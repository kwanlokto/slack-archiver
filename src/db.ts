import Database from "better-sqlite3";

export interface Channel {
  id: number;
  slack_id: string;
  name: string;
  is_private: number;
  enabled: number;
  last_message_ts: string | null;
  added_at: string;
}

export interface Message {
  id: number;
  channel_id: number;
  slack_ts: string;
  user_id: string | null;
  user_name: string | null;
  text: string;
  thread_ts: string | null;
  subtype: string | null;
  raw_json: string;
  archived_at: string;
}

export class Store {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        slack_id        TEXT NOT NULL UNIQUE,
        name            TEXT NOT NULL,
        is_private      INTEGER NOT NULL DEFAULT 0,
        enabled         INTEGER NOT NULL DEFAULT 1,
        last_message_ts TEXT,
        added_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        slack_ts    TEXT NOT NULL,
        user_id     TEXT,
        user_name   TEXT,
        text        TEXT NOT NULL,
        thread_ts   TEXT,
        subtype     TEXT,
        raw_json    TEXT NOT NULL,
        archived_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(channel_id, slack_ts)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel_ts
        ON messages(channel_id, slack_ts);

      CREATE INDEX IF NOT EXISTS idx_messages_thread
        ON messages(channel_id, thread_ts);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
        USING fts5(text, content='messages', content_rowid='id');

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.id, old.text);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.id, old.text);
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `);
  }

  addChannel(slackId: string, name: string, isPrivate: boolean): Channel {
    const stmt = this.db.prepare(`
      INSERT INTO channels (slack_id, name, is_private)
      VALUES (?, ?, ?)
      ON CONFLICT(slack_id) DO UPDATE SET name = excluded.name, enabled = 1
      RETURNING *
    `);
    return stmt.get(slackId, name, isPrivate ? 1 : 0) as Channel;
  }

  removeChannel(slackId: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM channels WHERE slack_id = ?`);
    return stmt.run(slackId).changes > 0;
  }

  setChannelEnabled(slackId: string, enabled: boolean): boolean {
    const stmt = this.db.prepare(`UPDATE channels SET enabled = ? WHERE slack_id = ?`);
    return stmt.run(enabled ? 1 : 0, slackId).changes > 0;
  }

  getChannelBySlackId(slackId: string): Channel | undefined {
    return this.db.prepare(`SELECT * FROM channels WHERE slack_id = ?`).get(slackId) as Channel | undefined;
  }

  getChannelByName(name: string): Channel | undefined {
    const clean = name.startsWith("#") ? name.slice(1) : name;
    return this.db.prepare(`SELECT * FROM channels WHERE name = ?`).get(clean) as Channel | undefined;
  }

  listChannels(): Channel[] {
    return this.db.prepare(`SELECT * FROM channels ORDER BY name`).all() as Channel[];
  }

  listEnabledChannels(): Channel[] {
    return this.db.prepare(`SELECT * FROM channels WHERE enabled = 1 ORDER BY name`).all() as Channel[];
  }

  updateLastMessageTs(channelId: number, ts: string): void {
    this.db.prepare(`UPDATE channels SET last_message_ts = ? WHERE id = ?`).run(ts, channelId);
  }

  insertMessages(channelId: number, messages: SlackRawMessage[]): { inserted: number; latestTs: string | null } {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO messages
        (channel_id, slack_ts, user_id, user_name, text, thread_ts, subtype, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let inserted = 0;
    let latestTs: string | null = null;

    const tx = this.db.transaction((msgs: SlackRawMessage[]) => {
      for (const m of msgs) {
        const result = insert.run(
          channelId,
          m.ts,
          m.user ?? null,
          m.user_profile?.real_name ?? m.username ?? null,
          m.text ?? "",
          m.thread_ts ?? null,
          m.subtype ?? null,
          JSON.stringify(m),
        );
        if (result.changes > 0) inserted++;
        if (!latestTs || parseFloat(m.ts) > parseFloat(latestTs)) latestTs = m.ts;
      }
    });

    tx(messages);
    return { inserted, latestTs };
  }

  getMessages(channelId: number, opts: { limit?: number; offset?: number; before?: string; after?: string } = {}): Message[] {
    const limit = Math.min(opts.limit ?? 100, 1000);
    const offset = opts.offset ?? 0;
    const clauses = ["channel_id = ?"];
    const params: (string | number)[] = [channelId];

    if (opts.before) {
      clauses.push("slack_ts < ?");
      params.push(opts.before);
    }
    if (opts.after) {
      clauses.push("slack_ts > ?");
      params.push(opts.after);
    }

    params.push(limit, offset);
    const sql = `SELECT * FROM messages WHERE ${clauses.join(" AND ")} ORDER BY slack_ts ASC LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...params) as Message[];
  }

  countMessages(channelId: number): number {
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM messages WHERE channel_id = ?`).get(channelId) as { c: number };
    return row.c;
  }

  searchMessages(query: string, channelId: number | null, limit = 50): (Message & { channel_name: string })[] {
    const params: (string | number)[] = [query];
    let where = "messages.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)";
    if (channelId !== null) {
      where += " AND messages.channel_id = ?";
      params.push(channelId);
    }
    params.push(limit);
    const sql = `
      SELECT messages.*, channels.name as channel_name
      FROM messages
      JOIN channels ON channels.id = messages.channel_id
      WHERE ${where}
      ORDER BY messages.slack_ts DESC
      LIMIT ?
    `;
    return this.db.prepare(sql).all(...params) as (Message & { channel_name: string })[];
  }
}

export interface SlackRawMessage {
  ts: string;
  user?: string;
  username?: string;
  text?: string;
  thread_ts?: string;
  subtype?: string;
  user_profile?: { real_name?: string; display_name?: string };
  [key: string]: unknown;
}
