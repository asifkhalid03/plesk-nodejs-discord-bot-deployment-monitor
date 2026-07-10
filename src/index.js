const express = require('express');
const path = require('path');
const config = require('./config');
const db = require('./db');
const DiscordService = require('./discord');
const WatcherManager = require('./watcherManager');
const registerRoutes = require('./routes');
const registerAuth = require('./auth');
const ReportBotService = require('./reportBot');

async function main() {
  await db.initDb();

  const app = express();
  function captureRawBody(req, res, buffer) {
    if (buffer?.length) req.rawBody = buffer.toString('utf8');
  }

  function setNoStoreHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
    res.setHeader('Surrogate-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }

  app.use((req, res, next) => {
    setNoStoreHeaders(res);
    next();
  });

  app.use(express.json({ limit: '1mb', verify: captureRawBody }));
  app.use(express.text({ type: ['text/*', 'application/x-www-form-urlencoded'], limit: '1mb', verify: captureRawBody }));
  registerAuth(app);
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    etag: false,
    maxAge: 0,
    setHeaders(res) {
      setNoStoreHeaders(res);
    }
  }));

  const discordService = new DiscordService();
  discordService.startInBackground();

  const watcherManager = new WatcherManager(discordService);
  const reportBotService = new ReportBotService(discordService);
  registerRoutes(app, watcherManager, discordService, reportBotService);
  await watcherManager.startEnabledWatchers();
  await watcherManager.startDeploymentQueues();
  if (config.reportBotAutoStart && discordService.isConfigured()) {
    reportBotService.start().catch((error) => {
      console.error('Report bot auto-start failed:', error.message);
    });
  }

  const server = app.listen(config.port, () => {
    console.log(`Web UI listening on http://localhost:${config.port}`);
  });

  async function shutdown() {
    console.log('Shutting down...');
    server.close();
    await watcherManager.shutdown();
    await discordService.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
