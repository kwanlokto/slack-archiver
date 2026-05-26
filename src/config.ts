import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

dotenv.config();

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

function optionalEmpty(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : undefined;
}

export interface Config {
  /** Pre-configured token from .env (legacy / advanced use). The wizard's stored token takes precedence. */
  envSlackToken: string | undefined;
  dbPath: string;
  credentialsPath: string;
  exportDir: string;
  scheduleCron: string;
  apiPort: number;
  apiHost: string;
}

export function loadConfig(): Config {
  const dbPath = path.resolve(optional("DB_PATH", "./data/archive.db"));
  const credentialsPath = path.resolve(
    optional("CREDENTIALS_PATH", path.join(path.dirname(dbPath), "credentials.json")),
  );
  const exportDir = path.resolve(optional("EXPORT_DIR", "./exports"));

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(exportDir, { recursive: true });

  return {
    envSlackToken: optionalEmpty("SLACK_TOKEN"),
    dbPath,
    credentialsPath,
    exportDir,
    scheduleCron: optional("SCHEDULE_CRON", "*/10 * * * *"),
    apiPort: parseInt(optional("API_PORT", "3000"), 10),
    apiHost: optional("API_HOST", "127.0.0.1"),
  };
}
