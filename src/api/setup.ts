import { Router } from "express";
import { WebClient } from "@slack/web-api";
import type { Runtime } from "../runtime";

export const REQUIRED_USER_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "users:read",
  "team:read",
];

export function buildSetupRouter(runtime: Runtime): Router {
  const r = Router();

  r.get("/status", (_req, res) => {
    const auth = runtime.credentials.getAuth();
    res.json({
      status: runtime.status,
      has_token: Boolean(auth),
      team: auth?.team_name ?? null,
      user_name: auth?.user_name ?? null,
      required_scopes: REQUIRED_USER_SCOPES,
    });
  });

  r.post("/token", (req, res, next) => {
    void (async () => {
      try {
        const raw = String((req.body as { token?: string }).token ?? "").trim();
        if (!raw) {
          res.status(400).json({ error: "token is required" });
          return;
        }
        if (!raw.startsWith("xoxp-")) {
          res.status(400).json({
            error: "Token must start with 'xoxp-' (a User OAuth Token). Bot tokens (xoxb-) won't work — we need user-scoped access.",
          });
          return;
        }

        // Validate and pull workspace + user info in one shot.
        const probe = new WebClient(raw);
        let authTest;
        try {
          authTest = await probe.auth.test();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.status(400).json({ error: `Token rejected by Slack: ${msg}` });
          return;
        }

        const userId = authTest.user_id as string;
        const userInfo = await probe.users.info({ user: userId });
        const u = userInfo.user as { name?: string; real_name?: string; is_owner?: boolean; is_primary_owner?: boolean } | undefined;

        if (!u?.is_owner && !u?.is_primary_owner) {
          res.status(403).json({
            error: `User @${authTest.user} is not a workspace owner. Only Workspace Owners may archive.`,
          });
          return;
        }

        runtime.credentials.setAuth({
          access_token: raw,
          team_id: authTest.team_id as string,
          team_name: authTest.team as string,
          authed_user_id: userId,
          user_name: u.real_name || u.name,
        });

        await runtime.activate(raw);

        res.json({ ok: true, status: runtime.status });
      } catch (err) {
        next(err);
      }
    })();
  });

  r.post("/disconnect", (_req, res) => {
    runtime.disconnect();
    res.json({ ok: true });
  });

  return r;
}
