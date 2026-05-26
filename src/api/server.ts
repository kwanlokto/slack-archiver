import express, { Express } from "express";
import * as path from "path";
import { buildRoutes } from "./routes";
import { buildSetupRouter } from "./setup";
import type { Runtime } from "../runtime";

export function createServer(runtime: Runtime): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.use("/api/setup", buildSetupRouter(runtime));
  app.use("/api", buildRoutes(runtime));

  // If the user opens "/" and there's no token, send them to the wizard.
  // This must run before express.static, which would otherwise serve index.html.
  app.get("/", (_req, res, next) => {
    if (runtime.status.state === "ready") {
      next();
      return;
    }
    res.redirect("/setup.html");
  });

  const publicDir = path.resolve(__dirname, "..", "..", "public");
  app.use(express.static(publicDir));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  return app;
}
