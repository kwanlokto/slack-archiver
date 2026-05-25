import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

dotenv.config();

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

export interface Config {
  slackToken: string;
  dbPath: string;
  exportDir: string;
  scheduleCron: string;
  apiPort: number;
  apiHost: string;
  adminPassword: string;
}

export function loadConfig(): Config {
  const dbPath = path.resolve(optional("DB_PATH", "./data/archive.db"));
  const exportDir = path.resolve(optional("EXPORT_DIR", "./exports"));

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(exportDir, { recursive: true });

  return {
    slackToken: required("SLACK_TOKEN"),
    dbPath,
    exportDir,
    scheduleCron: optional("SCHEDULE_CRON", "*/10 * * * *"),
    apiPort: parseInt(optional("API_PORT", "3000"), 10),
    apiHost: optional("API_HOST", "127.0.0.1"),
    adminPassword: optional("ADMIN_PASSWORD", ""),
  };
}
