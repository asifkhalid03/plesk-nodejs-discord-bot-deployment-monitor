# Plesk Deployment Setup

## Node.js Settings

In Plesk, open the domain or subdomain where this app will run, then go to **Node.js**.

Use these settings:

```text
Application root: /path/to/this/project
Application startup file: server.js
Document root: public
Application mode: production
```

Plesk usually provides `PORT` automatically. If it does, leave `PORT` out of the Plesk environment variables. If your Plesk setup requires a fixed port, set `PORT` there.

## Install Dependencies

From Plesk Node.js page, run:

```bash
npm install --omit=dev
npm run build
```

Or SSH into the app folder and run:

```bash
npm install --omit=dev
npm run build
```

## Environment Variables

Add these in Plesk **Node.js > Environment variables**, or upload a `.env` file outside public access.

Required:

```env
ENCRYPTION_KEY=generate_with_node_crypto
DATABASE_PATH=./data/app.db
```

Optional Web UI login:

```env
UI_LOGIN_EMAIL=admin@example.com
UI_LOGIN_PASSWORD=strong_password
UI_SESSION_SECRET=generate_with_node_crypto
```

Optional Discord features:

```env
DISCORD_TOKEN=your_discord_bot_token
GUILD_ID=your_discord_server_id
```

Recommended for Plesk/reverse proxy:

```env
TRUST_PROXY=true
IP_RESTRICT=false
DEFAULT_POLL_INTERVAL_SECONDS=2
WEBHOOK_TRIGGER_POLL_INTERVAL_SECONDS=10
BUFFER_DEPLOYMENT_BLOCKS=false
LARGE_LOG_ATTACHMENT_LINE_THRESHOLD=999999
```

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Use one generated value for `ENCRYPTION_KEY` and another for `UI_SESSION_SECRET`.

## Trigger Webhook

After creating a watcher in the UI, copy its trigger URL. It will look like:

```text
https://your-domain.com/hooks/YOUR_TOKEN
```

Call that URL when deployment starts:

```bash
curl "https://your-domain.com/hooks/YOUR_TOKEN"
```

The app will then read that watcher’s remote `deploy.log` over FTP/SFTP every `WEBHOOK_TRIGGER_POLL_INTERVAL_SECONDS` seconds and post new lines to Discord.

## Restart

After changing code or environment variables, click **Restart App** in Plesk.
