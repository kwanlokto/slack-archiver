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
cp .env.example .env       # optional — all values have working defaults
npm run build
npm start
```

Then open <http://127.0.0.1:3000/setup.html> and follow the wizard:

1. Create a Slack app at <https://api.slack.com/apps> → **From scratch**, in a
   workspace where you are an Owner.
2. On the new app's **OAuth & Permissions** page, scroll to **User Token
   Scopes** and add the scopes the wizard lists
   (`channels:history`, `channels:read`, `groups:history`, `groups:read`,
   `users:read`, `team:read`).
3. Scroll back up and click **Install to Workspace** → **Allow**.
4. Slack returns you to the OAuth & Permissions page and shows a **User OAuth
   Token** starting with `xoxp-`. Copy it.
5. Paste it into the wizard and click **Connect**. The daemon verifies you're a
   Workspace Owner, stores the token in `data/credentials.json`, and starts the
   scheduler.

No Redirect URLs, no Client ID/Secret, no OAuth round-trip — Slack hands you the
token directly after install.

> **Security model.** The HTTP API has no built-in auth — it binds to
> `127.0.0.1` by default and trusts everything on localhost. If you change
> `API_HOST` to a non-loopback address, put a reverse proxy with auth in front.

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

No auth — protected by binding to loopback only.

| Method | Path | Description |
| --- | --- | --- |
| GET    | `/api/channels` | List archived channels with counts |
| GET    | `/api/channels/:slackId/messages?limit=&offset=&before=&after=` | Paginated messages (ascending by ts) |
| GET    | `/api/search?q=&channel=&limit=` | FTS5 search across the archive |
| GET    | `/api/channels/:slackId/export?format=json\|jsonl\|csv\|txt` | Download an export file |
| POST   | `/api/channels` `{ "channel": "#general" }` | Add a channel |
| DELETE | `/api/channels/:slackId` | Remove a channel and all its messages |
| PATCH  | `/api/channels/:slackId` `{ "enabled": false }` | Pause/resume scheduling |
| POST   | `/api/channels/:slackId/extract` | Trigger one extraction for that channel |
| POST   | `/api/scheduler/tick` | Trigger a full extraction across all channels |
| GET    | `/api/setup/status` | Current connection status |
| POST   | `/api/setup/token` `{ "token": "xoxp-..." }` | Validate + store a user token |
| POST   | `/api/setup/disconnect` | Clear stored token |
| GET    | `/healthz` | Liveness probe |

### Example

```sh
curl http://127.0.0.1:3000/api/channels

curl -X POST http://127.0.0.1:3000/api/channels \
  -H 'content-type: application/json' \
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

## Troubleshooting the packaged .exe

When you double-click `slack-archiver-*.exe` and the window closes
instantly, the daemon hit a startup error before the HTTP server came up.
Two ways to see what happened:

1. **Read the log file.** A `slack-archiver.log` is written next to the
   `.exe`. It contains a timestamped copy of everything that would have
   printed to the console, including the full stack of the fatal error.
2. **Run it from a terminal.** Open `cmd` or PowerShell, `cd` to the folder
   containing the .exe, and run `.\slack-archiver-win.exe`. On a fatal
   error the daemon now prints `Press Enter to exit…` and waits, so the
   window stays open long enough to read the stack.

### Common causes

| Symptom in the log | What it means | Fix |
| --- | --- | --- |
| `EADDRINUSE` on port 3000 | Another copy of the daemon, or a different app, owns port 3000 | Kill it in Task Manager, or set `API_PORT=3100` in `.env` next to the exe |
| `ENOENT` opening the SQLite file | The folder you double-clicked from is read-only (e.g. inside an unzipped temp dir) | Move the .exe to a writable folder like `C:\slack-archiver\` |
| `Could not locate the bindings file` (better-sqlite3) | pkg failed to extract the native module — usually a corrupt download | Re-run `npm run package`, copy the fresh .exe out |
| Daemon stays running but `slack is not working` | No token configured | Open `http://127.0.0.1:3000/setup.html` and paste an `xoxp-` token |

The .exe expects to find (and will create) these files **next to itself**:

- `.env` — optional config overrides
- `data/archive.db` — the SQLite archive
- `data/credentials.json` — your Slack token, mode 0600
- `exports/` — files written by the export endpoint
- `slack-archiver.log` — append-only log

If you put the .exe somewhere the user can't write to, none of that works.

## Limitations and out-of-scope

- No auth on the HTTP layer — this is a single-user self-hosted tool, secured
  by loopback binding. For multi-user or remote access, put it behind a reverse
  proxy that handles auth + TLS.
- Files/attachments are not downloaded — only their metadata in `raw_json`.
- No backfill UI beyond what `conversations.history` returns; messages that
  Slack has already purged are gone.
