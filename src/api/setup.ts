import { Router } from "express";
import * as crypto from "crypto";
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

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

interface OAuthV2Response {
  ok: boolean;
  error?: string;
  team?: { id: string; name: string };
  authed_user?: {
    id: string;
    scope?: string;
    access_token?: string;
    token_type?: string;
  };
}

export function buildSetupRouter(runtime: Runtime): Router {
  const r = Router();
  const pendingStates = new Map<string, number>();

  r.get("/status", (_req, res) => {
    const app = runtime.credentials.getApp();
    const auth = runtime.credentials.getAuth();
    res.json({
      status: runtime.status,
      has_client_credentials: Boolean(app),
      has_token: Boolean(auth),
      team: auth?.team_name ?? null,
      user_name: auth?.user_name ?? null,
      redirect_uri: runtime.cfg.oauthRedirectUri,
      required_scopes: REQUIRED_USER_SCOPES,
    });
  });

  r.post("/credentials", (req, res) => {
    const body = req.body as { client_id?: string; client_secret?: string };
    const clientId = (body.client_id ?? "").trim();
    const clientSecret = (body.client_secret ?? "").trim();
    if (!clientId || !clientSecret) {
      res.status(400).json({ error: "client_id and client_secret are required" });
      return;
    }
    runtime.credentials.setApp({ client_id: clientId, client_secret: clientSecret });
    if (runtime.status.state === "unconfigured") {
      runtime.status = { state: "credentials_only", message: "App credentials saved — sign in with Slack to finish setup" };
    }
    res.json({ ok: true });
  });

  // Builds the Slack OAuth URL and 302s the browser to it. State is a random
  // nonce so the callback can prove the redirect came from a flow we started.
  r.get("/start", (_req, res) => {
    const app = runtime.credentials.getApp();
    if (!app) {
      res.status(400).type("text/plain").send("Save app credentials first.");
      return;
    }
    cleanupStates(pendingStates);
    const state = crypto.randomBytes(16).toString("hex");
    pendingStates.set(state, Date.now());

    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", app.client_id);
    url.searchParams.set("user_scope", REQUIRED_USER_SCOPES.join(","));
    url.searchParams.set("redirect_uri", runtime.cfg.oauthRedirectUri);
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  // Slack redirects the browser here with ?code=&state=. Exchange the code for
  // an xoxp- token, persist it, activate the runtime, then bounce the user
  // back to a UI page that reflects success or failure.
  r.get("/callback", (req, res, next) => {
    void (async () => {
      try {
        const code = req.query.code ? String(req.query.code) : "";
        const state = req.query.state ? String(req.query.state) : "";
        const slackError = req.query.error ? String(req.query.error) : "";
        if (slackError) {
          res.redirect(`/setup.html?error=${encodeURIComponent(slackError)}`);
          return;
        }
        if (!code || !state) {
          res.redirect(`/setup.html?error=${encodeURIComponent("missing code or state")}`);
          return;
        }
        if (!pendingStates.has(state)) {
          res.redirect(`/setup.html?error=${encodeURIComponent("state did not match — try again")}`);
          return;
        }
        pendingStates.delete(state);

        const app = runtime.credentials.getApp();
        if (!app) {
          res.redirect(`/setup.html?error=${encodeURIComponent("app credentials missing")}`);
          return;
        }

        const result = (await new WebClient().oauth.v2.access({
          client_id: app.client_id,
          client_secret: app.client_secret,
          code,
          redirect_uri: runtime.cfg.oauthRedirectUri,
        })) as unknown as OAuthV2Response;

        const userToken = result.authed_user?.access_token;
        if (!result.ok || !userToken) {
          const msg = result.error ?? "token exchange returned no user access_token";
          res.redirect(`/setup.html?error=${encodeURIComponent(msg)}`);
          return;
        }

        // Look up the user's display name for nicer UI; non-fatal if it fails.
        let userName: string | undefined;
        try {
          const probe = new WebClient(userToken);
          const info = await probe.users.info({ user: result.authed_user!.id });
          const u = info.user as { name?: string; real_name?: string } | undefined;
          userName = u?.real_name || u?.name;
        } catch {
          /* ignore — name is cosmetic */
        }

        runtime.credentials.setAuth({
          access_token: userToken,
          scope: result.authed_user?.scope ?? "",
          team_id: result.team?.id ?? "",
          team_name: result.team?.name ?? "",
          authed_user_id: result.authed_user!.id,
          user_name: userName,
        });

        await runtime.activate(userToken);

        if (runtime.status.state === "ready") {
          res.redirect("/setup.html?ok=1");
        } else {
          res.redirect(`/setup.html?error=${encodeURIComponent(runtime.status.message)}`);
        }
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

function cleanupStates(map: Map<string, number>): void {
  const cutoff = Date.now() - OAUTH_STATE_TTL_MS;
  for (const [k, ts] of map) if (ts < cutoff) map.delete(k);
}
