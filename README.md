# Slack Archiver

Archive Slack channel history to a local SQLite database so that messages survive the
free tier's 10,000-message cap. Runs as a long-lived daemon that periodically pulls
new messages, exposes a REST API + small web UI, and ships with a CLI for admin
tasks and exports.

## Why

Slack's free workspaces purge messages once the workspace passes 10K total. For OSS
projects and small communities that's a steady erosion of institutional knowledge.
This tool keeps a permanent copy of channels you care about.

## Features

- Add/remove channels (by ID or `#name`) from the archive list — CLI, REST, or UI.
- **Owner-only**: refuses to start unless the configured Slack token belongs to a
  Workspace Owner or Primary Owner.
- Periodic, incremental extraction (cron-scheduled). Each channel resumes from its
  last archived message — no duplicate work, no skipped messages.
- Captures thread replies opportunistically.
- Per-channel export to JSON / JSONL / CSV / TXT.
- REST API for reading + searching the archive (SQLite FTS5).
- Single-page web UI for channel management, search, and browsing.
- Designed around Slack's `conversations.history` rate limits (Tier 3, ~50 req/min).
  The SDK's built-in retry honors `Retry-After` headers automatically.

## Requirements

- Node.js 18+
- The ability to install a Slack app in a workspace where you are an **Owner**
  (one-time, ~2 min).

## Quick start

```sh
npm install
cp .env.example .env       # set ADMIN_PASSWORD (everything else is optional)
npm run build
npm start
```

Then open <http://127.0.0.1:3000/setup.html> and walk through the wizard:

1. Enter the `ADMIN_PASSWORD` you set in `.env`.
2. Create a Slack app at <https://api.slack.com/apps> → **From scratch**. The
   wizard shows you the exact **Redirect URL** and **User Token Scopes** to add.
3. Paste the app's **Client ID** and **Client Secret** into the wizard.
4. Click **Sign in with Slack**, approve the scopes, and Slack redirects back
   with a token. The daemon stores it in `data/credentials.json`, verifies you
   are a Workspace Owner, and starts the scheduler.

No copy-paste of `xoxp-` tokens required.

### Skipping the wizard (advanced)

If you already have a `xoxp-` user token, set `SLACK_TOKEN=xoxp-...` in `.env`
and the daemon will use it without showing the wizard.

## What the daemon does

- Starts the REST API + web UI on `API_HOST:API_PORT` (default
  `127.0.0.1:3000`).
- Once a Slack connection exists, runs `SCHEDULE_CRON` (default every 10 min) to
  pull new messages, and kicks off an immediate extraction on every (re)connect.
- Refuses to archive unless the connected user is a Workspace Owner.

## CLI

```sh
npm run cli -- verify                       # token + owner check
npm run cli -- add-channel #general         # by name or ID
npm run cli -- remove-channel #general
npm run cli -- list-channels
npm run cli -- enable #general
npm run cli -- disable #general
npm run cli -- extract                      # one-shot, all enabled channels
npm run cli -- extract #general             # one-shot, single channel
npm run cli -- export #general --format csv
```

(After `npm run build` you can also use `node dist/cli.js …` or the `slack-archiver`
bin.)

## REST API

Read endpoints are open. Write endpoints require the `x-admin-password` header to
match `ADMIN_PASSWORD` from the environment.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET    | `/api/channels` | — | List archived channels with counts |
| GET    | `/api/channels/:slackId/messages?limit=&offset=&before=&after=` | — | Paginated messages (ascending by ts) |
| GET    | `/api/search?q=&channel=&limit=` | — | FTS5 search across the archive |
| GET    | `/api/channels/:slackId/export?format=json\|jsonl\|csv\|txt` | — | Download an export file |
| POST   | `/api/channels` `{ "channel": "#general" }` | admin | Add a channel |
| DELETE | `/api/channels/:slackId` | admin | Remove a channel and all its messages |
| PATCH  | `/api/channels/:slackId` `{ "enabled": false }` | admin | Pause/resume scheduling |
| POST   | `/api/channels/:slackId/extract` | admin | Trigger one extraction for that channel |
| POST   | `/api/scheduler/tick` | admin | Trigger a full extraction across all channels |
| GET    | `/api/setup/status` | — | Current connection status |
| POST   | `/api/setup/credentials` `{ "client_id": "...", "client_secret": "..." }` | admin | Save Slack app credentials |
| GET    | `/api/setup/start` | — | 302 to Slack OAuth |
| GET    | `/api/setup/callback?code=&state=` | — | OAuth redirect target |
| POST   | `/api/setup/disconnect` | admin | Clear stored token |
| GET    | `/healthz` | — | Liveness probe |

### Example

```sh
curl http://127.0.0.1:3000/api/channels

curl -X POST http://127.0.0.1:3000/api/channels \
  -H 'content-type: application/json' \
  -H 'x-admin-password: change-me' \
  -d '{"channel": "#general"}'

curl 'http://127.0.0.1:3000/api/search?q=migration&limit=20'
```

## Data model

A single SQLite file at `DB_PATH` (default `./data/archive.db`) with three logical
tables:

- `channels` — one row per archived channel (`slack_id`, `name`, `enabled`,
  `last_message_ts`).
- `messages` — one row per Slack message (`channel_id`, `slack_ts`, `user_id`,
  `user_name`, `text`, `thread_ts`, `subtype`, `raw_json`). Uniqueness on
  `(channel_id, slack_ts)` makes inserts idempotent.
- `messages_fts` — FTS5 virtual table mirroring `messages.text` for search.

`raw_json` preserves the full Slack payload so future schema additions can be
back-filled without re-fetching.

## How extraction works

For each enabled channel, the archiver calls `conversations.history` paginated with
`oldest = channels.last_message_ts` and `inclusive=false`. After each page is
inserted into SQLite, the channel's watermark is updated — so if the process dies
mid-run, the next tick resumes exactly where it left off.

When a message has `reply_count > 0`, `conversations.replies` is called to capture
the thread. Thread replies are stored as regular messages with `thread_ts` set.

Rate limiting is handled by `@slack/web-api`'s built-in retry — it respects
`Retry-After` and backs off exponentially.

## Deployment notes

- The daemon is a single Node process. Use Windows Task Scheduler, NSSM,
  systemd, pm2, or a Docker container to keep it alive.
- The SQLite file is portable — back it up by copying the `.db` file (use
  `sqlite3 archive.db ".backup snapshot.db"` for a hot backup).
- Bind `API_HOST=0.0.0.0` only if you trust your network; otherwise keep it on
  loopback and put a reverse proxy in front for TLS + real auth.

## Limitations and out-of-scope

- No user OAuth flow — this is a self-hosted operator tool, secured by the owner
  token + `ADMIN_PASSWORD`. For multi-user access, add an auth proxy.
- Files/attachments are not downloaded — only their metadata in `raw_json`.
- No backfill UI beyond what `conversations.history` returns; messages that
  Slack has already purged are gone.
