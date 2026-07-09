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
  app.use(express.json({ limit: '1mb' }));
  app.use(express.text({ type: ['text/*', 'application/x-www-form-urlencoded'], limit: '1mb' }));
  registerAuth(app);
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    etag: false,
    maxAge: 0,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-store');
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
