import { Router, Request, Response, NextFunction } from "express";
import type { Store } from "../db";
import type { SlackClient } from "../slack";
import type { Scheduler } from "../scheduler";
import { exportChannel, ExportFormat } from "../exporter";
import { extractChannel } from "../archiver";

export interface RoutesDeps {
  store: Store;
  slack: SlackClient;
  scheduler: Scheduler;
  adminPassword: string;
  exportDir: string;
}

export function buildRoutes(deps: RoutesDeps): Router {
  const r = Router();
  const { store, slack, scheduler, adminPassword, exportDir } = deps;

  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    if (!adminPassword) {
      res.status(503).json({ error: "ADMIN_PASSWORD is not configured on the server" });
      return;
    }
    const provided = req.header("x-admin-password");
    if (provided !== adminPassword) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  // ---- Read endpoints (open) ----

  r.get("/channels", (_req, res) => {
    const channels = store.listChannels().map((c) => ({
      ...c,
      message_count: store.countMessages(c.id),
    }));
    res.json({ channels });
  });

  r.get("/channels/:slackId/messages", (req, res) => {
    const ch = store.getChannelBySlackId(req.params.slackId);
    if (!ch) {
      res.status(404).json({ error: "channel not archived" });
      return;
    }
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;
    const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
    const before = req.query.before ? String(req.query.before) : undefined;
    const after = req.query.after ? String(req.query.after) : undefined;
    const messages = store.getMessages(ch.id, { limit, offset, before, after });
    res.json({
      channel: { id: ch.slack_id, name: ch.name },
      total: store.countMessages(ch.id),
      count: messages.length,
      messages,
    });
  });

  r.get("/search", (req, res) => {
    const q = req.query.q ? String(req.query.q).trim() : "";
    if (!q) {
      res.status(400).json({ error: "missing query param `q`" });
      return;
    }
    const channelSlackId = req.query.channel ? String(req.query.channel) : null;
    let channelId: number | null = null;
    if (channelSlackId) {
      const ch = store.getChannelBySlackId(channelSlackId);
      if (!ch) {
        res.status(404).json({ error: "channel not archived" });
        return;
      }
      channelId = ch.id;
    }
    const limit = req.query.limit ? Math.min(parseInt(String(req.query.limit), 10), 500) : 50;
    const results = store.searchMessages(q, channelId, limit);
    res.json({ query: q, count: results.length, results });
  });

  r.get("/channels/:slackId/export", (req, res, next) => {
    void (async () => {
      try {
        const ch = store.getChannelBySlackId(req.params.slackId);
        if (!ch) {
          res.status(404).json({ error: "channel not archived" });
          return;
        }
        const fmt = (String(req.query.format ?? "jsonl") as ExportFormat);
        if (!["json", "jsonl", "csv", "txt"].includes(fmt)) {
          res.status(400).json({ error: "format must be one of: json, jsonl, csv, txt" });
          return;
        }
        const result = exportChannel(store, ch, exportDir, fmt);
        res.download(result.path);
      } catch (err) {
        next(err);
      }
    })();
  });

  // ---- Write endpoints (admin only) ----

  r.post("/channels", requireAdmin, (req, res, next) => {
    void (async () => {
      try {
        const ref = String((req.body as { channel?: string }).channel ?? "").trim();
        if (!ref) {
          res.status(400).json({ error: "body must contain `channel` (id or name)" });
          return;
        }
        const info = await slack.resolveChannel(ref);
        const ch = store.addChannel(info.id, info.name, info.is_private);
        res.status(201).json({ channel: ch });
      } catch (err) {
        next(err);
      }
    })();
  });

  r.delete("/channels/:slackId", requireAdmin, (req, res) => {
    const ok = store.removeChannel(req.params.slackId);
    if (!ok) {
      res.status(404).json({ error: "channel not archived" });
      return;
    }
    res.json({ ok: true });
  });

  r.patch("/channels/:slackId", requireAdmin, (req, res) => {
    const body = req.body as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") {
      res.status(400).json({ error: "body must contain boolean `enabled`" });
      return;
    }
    const ok = store.setChannelEnabled(req.params.slackId, body.enabled);
    if (!ok) {
      res.status(404).json({ error: "channel not archived" });
      return;
    }
    res.json({ ok: true });
  });

  r.post("/channels/:slackId/extract", requireAdmin, (req, res, next) => {
    void (async () => {
      try {
        const ch = store.getChannelBySlackId(req.params.slackId);
        if (!ch) {
          res.status(404).json({ error: "channel not archived" });
          return;
        }
        const result = await extractChannel(slack, store, ch);
        res.json({ result });
      } catch (err) {
        next(err);
      }
    })();
  });

  r.post("/scheduler/tick", requireAdmin, (_req, res, next) => {
    void (async () => {
      try {
        await scheduler.tick();
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    })();
  });

  // ---- Error handler ----
  r.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[api] error:", err);
    res.status(500).json({ error: err.message });
  });

  return r;
}
