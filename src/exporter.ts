import * as fs from "fs";
import * as path from "path";
import type { Store, Channel, Message } from "./db";

export type ExportFormat = "json" | "jsonl" | "csv" | "txt";

export interface ExportResult {
  path: string;
  format: ExportFormat;
  messageCount: number;
}

export function exportChannel(
  store: Store,
  channel: Channel,
  exportDir: string,
  format: ExportFormat,
): ExportResult {
  fs.mkdirSync(exportDir, { recursive: true });
  const fileName = `${channel.name}-${Date.now()}.${format}`;
  const fullPath = path.join(exportDir, fileName);

  const pageSize = 1000;
  let offset = 0;
  let total = 0;

  const stream = fs.createWriteStream(fullPath);

  try {
    if (format === "json") stream.write("[\n");
    if (format === "csv") stream.write("ts,iso,user_id,user_name,thread_ts,subtype,text\n");

    let first = true;
    // Pull pages until exhausted
    while (true) {
      const page = store.getMessages(channel.id, { limit: pageSize, offset });
      if (page.length === 0) break;
      for (const m of page) {
        const line = formatMessage(m, format, first);
        stream.write(line);
        first = false;
      }
      total += page.length;
      offset += pageSize;
    }

    if (format === "json") stream.write("\n]\n");
  } finally {
    stream.end();
  }

  return { path: fullPath, format, messageCount: total };
}

function formatMessage(m: Message, format: ExportFormat, first: boolean): string {
  switch (format) {
    case "json": {
      const sep = first ? "  " : ",\n  ";
      return sep + JSON.stringify({
        ts: m.slack_ts,
        iso: tsToIso(m.slack_ts),
        user_id: m.user_id,
        user_name: m.user_name,
        text: m.text,
        thread_ts: m.thread_ts,
        subtype: m.subtype,
      });
    }
    case "jsonl":
      return JSON.stringify({
        ts: m.slack_ts,
        iso: tsToIso(m.slack_ts),
        user_id: m.user_id,
        user_name: m.user_name,
        text: m.text,
        thread_ts: m.thread_ts,
        subtype: m.subtype,
      }) + "\n";
    case "csv":
      return [
        m.slack_ts,
        tsToIso(m.slack_ts),
        m.user_id ?? "",
        m.user_name ?? "",
        m.thread_ts ?? "",
        m.subtype ?? "",
        csvEscape(m.text),
      ].join(",") + "\n";
    case "txt":
      return `[${tsToIso(m.slack_ts)}] ${m.user_name ?? m.user_id ?? "unknown"}: ${m.text}\n`;
  }
}

function tsToIso(ts: string): string {
  const secs = parseFloat(ts);
  if (Number.isNaN(secs)) return "";
  return new Date(secs * 1000).toISOString();
}

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
