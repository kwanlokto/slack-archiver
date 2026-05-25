import * as fs from "fs";
import * as path from "path";

export interface AppCredentials {
  client_id: string;
  client_secret: string;
}

export interface SlackAuth {
  access_token: string; // xoxp-...
  scope: string;
  team_id: string;
  team_name: string;
  authed_user_id: string;
  user_name?: string;
}

export interface StoredCredentials {
  app?: AppCredentials;
  auth?: SlackAuth;
}

/**
 * Persists OAuth state to a JSON file alongside the database. Values written
 * here take precedence over .env (so the wizard's choice wins). The file path
 * itself sits inside DB_PATH's directory and is gitignored via `data/`.
 */
export class CredentialsStore {
  private cache: StoredCredentials | null = null;

  constructor(private readonly filePath: string) {}

  load(): StoredCredentials {
    if (this.cache) return this.cache;
    if (!fs.existsSync(this.filePath)) {
      this.cache = {};
      return this.cache;
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      this.cache = JSON.parse(raw) as StoredCredentials;
    } catch (err) {
      console.warn(`[credentials] failed to read ${this.filePath}: ${(err as Error).message}`);
      this.cache = {};
    }
    return this.cache;
  }

  save(creds: StoredCredentials): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(creds, null, 2), { mode: 0o600 });
    this.cache = creds;
  }

  setApp(app: AppCredentials): void {
    const current = this.load();
    this.save({ ...current, app });
  }

  setAuth(auth: SlackAuth): void {
    const current = this.load();
    this.save({ ...current, auth });
  }

  clearAuth(): void {
    const current = this.load();
    this.save({ ...current, auth: undefined });
  }

  getApp(): AppCredentials | undefined {
    return this.load().app;
  }

  getAuth(): SlackAuth | undefined {
    return this.load().auth;
  }

  getAccessToken(): string | undefined {
    return this.load().auth?.access_token;
  }
}
