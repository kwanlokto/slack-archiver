import express, { Express } from "express";
import * as path from "path";
import { buildRoutes, RoutesDeps } from "./routes";

export function createServer(deps: RoutesDeps): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Mount API routes
  app.use("/api", buildRoutes(deps));

  // Static admin UI
  const publicDir = path.resolve(__dirname, "..", "..", "public");
  app.use(express.static(publicDir));

  // Health check
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  return app;
}
