import * as fs from "fs";
import * as path from "path";

export interface SlackAuth {
  access_token: string; // xoxp-...
  team_id?: string;
  team_name?: string;
  authed_user_id?: string;
  user_name?: string;
}

export interface StoredCredentials {
  auth?: SlackAuth;
}

/**
 * Persists the Slack user token (and a little workspace metadata for the UI)
 * to a JSON file alongside the database. Values written here take precedence
 * over `.env`'s SLACK_TOKEN so the wizard's choice wins.
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

  setAuth(auth: SlackAuth): void {
    this.save({ auth });
  }

  clearAuth(): void {
    this.save({});
  }

  getAuth(): SlackAuth | undefined {
    return this.load().auth;
  }

  getAccessToken(): string | undefined {
    return this.load().auth?.access_token;
  }
}
