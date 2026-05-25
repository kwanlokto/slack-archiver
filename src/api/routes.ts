import { Router, Request, Response, NextFunction } from "express";
import type { Runtime } from "../runtime";
import { exportChannel, ExportFormat } from "../exporter";
import { extractChannel } from "../archiver";

export function buildRoutes(runtime: Runtime, adminPassword: string): Router {
  const r = Router();

  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    if (!adminPassword) {
      res.status(503).json({ error: "ADMIN_PASSWORD is not configured on the server" });
      return;
    }
    if (req.header("x-admin-password") !== adminPassword) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  /**
   * Most write endpoints additionally require a live Slack connection — there's
   * no point trying to add a channel if we have no token yet. Reads still work
   * because they hit SQLite, not Slack.
   */
  const requireReady = (_req: Request, res: Response, next: NextFunction): void => {
    if (!runtime.isReady() || !runtime.slack) {
      res.status(412).json({ error: "Slack is not connected. Complete /setup first." });
      return;
    }
    next();
  };

  // ---- Read endpoints (open) ----

  r.get("/channels", (_req, res) => {
    const channels = runtime.store.listChannels().map((c) => ({
      ...c,
      message_count: runtime.store.countMessages(c.id),
    }));
    res.json({ channels });
  });

  r.get("/channels/:slackId/messages", (req, res) => {
    const ch = runtime.store.getChannelBySlackId(req.params.slackId);
    if (!ch) {
      res.status(404).json({ error: "channel not archived" });
      return;
    }
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;
    const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
    const before = req.query.before ? String(req.query.before) : undefined;
    const after = req.query.after ? String(req.query.after) : undefined;
    const messages = runtime.store.getMessages(ch.id, { limit, offset, before, after });
    res.json({
      channel: { id: ch.slack_id, name: ch.name },
      total: runtime.store.countMessages(ch.id),
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
      const ch = runtime.store.getChannelBySlackId(channelSlackId);
      if (!ch) {
        res.status(404).json({ error: "channel not archived" });
        return;
      }
      channelId = ch.id;
    }
    const limit = req.query.limit ? Math.min(parseInt(String(req.query.limit), 10), 500) : 50;
    const results = runtime.store.searchMessages(q, channelId, limit);
    res.json({ query: q, count: results.length, results });
  });

  r.get("/channels/:slackId/export", (req, res, next) => {
    void (async () => {
      try {
        const ch = runtime.store.getChannelBySlackId(req.params.slackId);
        if (!ch) {
          res.status(404).json({ error: "channel not archived" });
          return;
        }
        const fmt = (String(req.query.format ?? "jsonl") as ExportFormat);
        if (!["json", "jsonl", "csv", "txt"].includes(fmt)) {
          res.status(400).json({ error: "format must be one of: json, jsonl, csv, txt" });
          return;
        }
        const result = exportChannel(runtime.store, ch, runtime.cfg.exportDir, fmt);
        res.download(result.path);
      } catch (err) {
        next(err);
      }
    })();
  });

  // ---- Write endpoints (admin + Slack connection required) ----

  r.post("/channels", requireAdmin, requireReady, (req, res, next) => {
    void (async () => {
      try {
        const ref = String((req.body as { channel?: string }).channel ?? "").trim();
        if (!ref) {
          res.status(400).json({ error: "body must contain `channel` (id or name)" });
          return;
        }
        const info = await runtime.slack!.resolveChannel(ref);
        const ch = runtime.store.addChannel(info.id, info.name, info.is_private);
        res.status(201).json({ channel: ch });
      } catch (err) {
        next(err);
      }
    })();
  });

  r.delete("/channels/:slackId", requireAdmin, (req, res) => {
    const ok = runtime.store.removeChannel(req.params.slackId);
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
    const ok = runtime.store.setChannelEnabled(req.params.slackId, body.enabled);
    if (!ok) {
      res.status(404).json({ error: "channel not archived" });
      return;
    }
    res.json({ ok: true });
  });

  r.post("/channels/:slackId/extract", requireAdmin, requireReady, (req, res, next) => {
    void (async () => {
      try {
        const ch = runtime.store.getChannelBySlackId(req.params.slackId);
        if (!ch) {
          res.status(404).json({ error: "channel not archived" });
          return;
        }
        const result = await extractChannel(runtime.slack!, runtime.store, ch);
        res.json({ result });
      } catch (err) {
        next(err);
      }
    })();
  });

  r.post("/scheduler/tick", requireAdmin, requireReady, (_req, res, next) => {
    void (async () => {
      try {
        await runtime.scheduler!.tick();
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
