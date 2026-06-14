# Discord Remote Log Watcher

A Node.js Discord bot with a small web UI for polling remote FTP/SFTP deployment logs and forwarding newly appended log lines to Discord channels.

## Features

- Add, edit, delete, start, and stop multiple log watchers.
- Supports SFTP via `ssh2-sftp-client` and FTP via `basic-ftp`.
- Polls remote log files like `tail -f`.
- Sends each new log line to a configured Discord channel.
- Handles reconnects, truncation, and log rotation.
- Persists watcher config and offsets in SQLite.
- Encrypts stored passwords and private keys using AES-256-GCM.
- Shows live watcher status in the web UI.
- Includes test connection and test Discord message actions.

## Discord Setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create an application, then create a bot for it.
3. Copy the bot token into `.env` as `DISCORD_BOT_TOKEN`. If you already use `DISCORD_TOKEN`, that works too.
4. In the Bot settings, enable the permissions your server requires. This app only needs to send messages, but resolving channel names is easier when the bot can see channels.
5. Invite the bot to your server using OAuth2 URL Generator:
   - Scopes: `bot`
   - Bot permissions: `Send Messages`, `View Channels`, optionally `Read Message History`
6. Copy a channel ID from Discord by enabling Developer Mode, right-clicking a channel, and choosing Copy Channel ID. Channel names can work when `DISCORD_GUILD_ID` or `GUILD_ID` is set and the bot can access the guild, but channel IDs are most reliable.

## Environment Variables

Copy `.env.example` to `.env` and fill it in:

```bash
cp .env.example .env
```

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Required variables:

- `ENCRYPTION_KEY`: Base64, hex, or plain string with enough entropy. Used to encrypt stored FTP/SFTP secrets.
- `DISCORD_BOT_TOKEN`: Discord bot token. Alias: `DISCORD_TOKEN`.

Optional variables:

- `PORT`: Web UI/API port. Defaults to `3000`.
- `DATABASE_PATH`: SQLite file path. Defaults to `./data/app.db`.
- `DISCORD_GUILD_ID`: Used to resolve channel names. Alias: `GUILD_ID`.
- `DEFAULT_POLL_INTERVAL_SECONDS`: Defaults to `5`.
- `MAX_DISCORD_MESSAGE_LENGTH`: Defaults to `1900`.
- `LARGE_LOG_ATTACHMENT_LINE_THRESHOLD`: Defaults to `60`. Larger poll bursts are sent as a file instead of many messages.
- `COMPRESS_LARGE_LOG_ATTACHMENTS`: Defaults to `true`. Sends large bursts as `.log.gz` so Discord does not render a slow inline preview.
- `UI_LOGIN_EMAIL`: Email used for the web UI login page.
- `UI_LOGIN_PASSWORD`: Password used for the web UI login page.
- `UI_SESSION_SECRET`: Secret used to sign UI session cookies. Generate it like `ENCRYPTION_KEY`.
- `IP_RESTRICT`: Set to `true` to allow only IPs in `IP_ALLOWLIST`.
- `IP_ALLOWLIST`: Comma-separated allowed IP addresses, for example `127.0.0.1,192.168.1.20`.
- `TRUST_PROXY`: Set to `true` only when the app is behind a trusted reverse proxy that sends `X-Forwarded-For`.

## Web UI Access Control

The web UI and API require login when `UI_LOGIN_EMAIL` and `UI_LOGIN_PASSWORD` are set.

To restrict access by IP too:

```env
IP_RESTRICT=true
IP_ALLOWLIST=127.0.0.1,192.168.1.20
```

If you run behind Nginx, Cloudflare Tunnel, Plesk proxy, or another trusted reverse proxy, set:

```env
TRUST_PROXY=true
```

## Install and Run Locally

```bash
npm install
cp .env.example .env
npm start
```

Open:

```text
http://localhost:3000
```

## Run on a Server

1. Install Node.js 20 LTS or newer.
2. Clone or upload this project.
3. Run `npm install --omit=dev`.
4. Create `.env` with `DISCORD_BOT_TOKEN` or `DISCORD_TOKEN`, plus `ENCRYPTION_KEY`.
5. Start with a process manager:

```bash
npm install -g pm2
pm2 start src/index.js --name discord-log-watcher
pm2 save
pm2 startup
```

## Clear Recent Channel Messages

The web UI has a `Clear channel` button in each watcher row. It clears recent messages from that watcher's configured Discord channel after confirmation.

The bot needs `Manage Messages`, `View Channel`, and `Read Message History`.

Each watcher can also auto-clear its Discord channel once per day:

- Enable `Auto clear Discord channel daily`.
- Pick an `Auto clear time` in the server's local timezone.
- Set `Auto clear limit` to a number such as `100`, or `all`.

Discord still only bulk-deletes messages newer than 14 days.

There is also a CLI option:

```bash
npm run clear-channel -- 1439515416711004250 100 --yes
```

To delete all recent messages the Discord API allows:

```bash
npm run clear-channel -- 1439515416711004250 all --yes
```

Discord bulk deletion only works for messages newer than 14 days. Older messages must be deleted manually or one-by-one, which is intentionally not included here because it is slow and easy to rate-limit.

## Watcher Behavior

- Remote file watching is not available for most FTP/SFTP servers, so this app polls.
- On first start, a watcher begins at the current end of the remote file to avoid flooding Discord with old logs.
- After that, it stores byte offsets in SQLite and only sends newly appended lines.
- If the file shrinks, the app treats it as truncation or rotation and starts reading from the beginning of the new file.
- For timestamped deployment files, use a wildcard path such as `/httpdocs/deployment/deploy-*.log`. The watcher resolves the newest matching filename on each poll and switches when a newer log appears.
- If the connection drops, the watcher retries automatically.
- Partial lines are buffered until they end with a newline.

## Trigger Webhooks

Each watcher has its own trigger webhook URL in the table. Use `Copy trigger` and call it from your deploy script when deployment starts.

The webhook does not send the posted text to Discord. It tells this app to start reading that watcher's remote `deploy.log` by FTP/SFTP every `WEBHOOK_TRIGGER_POLL_INTERVAL_SECONDS` seconds. The temporary watcher stops when it sees `DEPLOYMENT_BLOCK_END_TEXT`, for example `Deployment finished`.

When a trigger webhook starts a new deployment read, the app first clears recent messages from that watcher's Discord channel using the watcher `Auto clear limit` value.

```bash
curl "http://localhost:3000/hooks/YOUR_TOKEN"
```

For a public server, use your real app URL:

```bash
curl "https://your-domain.com/hooks/YOUR_TOKEN"
```

Keep webhook URLs secret. If one leaks, click `Reset webhook` for that watcher.

## Security Notes

- Secrets are encrypted at rest with `ENCRYPTION_KEY`. Keep that key private and stable.
- If you lose or change `ENCRYPTION_KEY`, existing stored secrets cannot be decrypted.
- Prefer SFTP over FTP. FTP credentials are sent insecurely unless your server supports FTPS, which this simple implementation does not configure.
- Put this UI behind a trusted network, VPN, reverse proxy auth, or firewall before exposing it publicly. The included UI does not implement user login.

## Project Structure

```text
src/
  index.js              App entrypoint
  config.js             Environment config
  db.js                 SQLite schema and queries
  crypto.js             Secret encryption/decryption
  discord.js            Discord client wrapper
  remoteClients.js      FTP/SFTP client helpers
  watcherManager.js     Polling and runtime status manager
  routes.js             Express API routes
public/
  index.html            Web UI
  styles.css            UI styling
  app.js                UI behavior
```
