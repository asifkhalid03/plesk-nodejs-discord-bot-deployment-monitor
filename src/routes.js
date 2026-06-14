const express = require('express');
const db = require('./db');
const { testRemoteConnection } = require('./remoteClients');

function validateWatcherPayload(body, { partial = false } = {}) {
  const required = ['name', 'protocol', 'host', 'port', 'username', 'remotePath', 'discordChannel'];
  for (const field of required) {
    if (!partial && (body[field] === undefined || body[field] === '')) {
      throw new Error(`${field} is required.`);
    }
  }

  const protocol = body.protocol || 'sftp';
  if (!['sftp', 'ftp'].includes(protocol)) {
    throw new Error('protocol must be sftp or ftp.');
  }

  const port = Number(body.port || (protocol === 'sftp' ? 22 : 21));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('port must be a valid TCP port.');
  }

  const pollIntervalSeconds = Number(body.pollIntervalSeconds || 5);
  if (!Number.isInteger(pollIntervalSeconds) || pollIntervalSeconds < 2) {
    throw new Error('pollIntervalSeconds must be at least 2.');
  }

  const autoClearTime = String(body.autoClearTime || '00:00').trim();
  if (!/^\d{2}:\d{2}$/.test(autoClearTime)) {
    throw new Error('autoClearTime must use HH:MM format.');
  }

  const [autoClearHour, autoClearMinute] = autoClearTime.split(':').map(Number);
  if (autoClearHour > 23 || autoClearMinute > 59) {
    throw new Error('autoClearTime must be a valid time.');
  }

  const autoClearLimit = String(body.autoClearLimit || '100').trim().toLowerCase();
  if (autoClearLimit !== 'all' && (!/^\d+$/.test(autoClearLimit) || Number(autoClearLimit) < 1)) {
    throw new Error('autoClearLimit must be a positive number or "all".');
  }

  return {
    name: String(body.name || '').trim(),
    protocol,
    host: String(body.host || '').trim(),
    port,
    username: String(body.username || '').trim(),
    password: body.password === undefined || body.password === '' ? undefined : String(body.password),
    privateKey: body.privateKey === undefined || body.privateKey === '' ? undefined : String(body.privateKey),
    remotePath: String(body.remotePath || '').trim(),
    discordChannel: String(body.discordChannel || '').trim(),
    pollIntervalSeconds,
    enabled: Boolean(body.enabled),
    autoClearEnabled: Boolean(body.autoClearEnabled),
    autoClearTime,
    autoClearLimit
  };
}

function registerRoutes(app, watcherManager, discordService) {
  const router = express.Router();

  async function handleTriggerWebhook(req, res, next) {
    try {
      const watcher = await db.getWatcherByWebhookToken(req.params.token);
      if (!watcher) return res.status(404).json({ error: 'Webhook not found.' });

      const status = await watcherManager.triggerWebhook(watcher.id);
      res.json({ ok: true, status });
    } catch (error) {
      next(error);
    }
  }

  app.get('/hooks/:token', handleTriggerWebhook);
  app.post('/hooks/:token', handleTriggerWebhook);

  router.get('/watchers', async (req, res, next) => {
    try {
      const watchers = await db.listWatchers();
      res.json({
        watchers: watchers.map((watcher) => ({
          ...watcher,
          status: watcherManager.getStatus(watcher.id)
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/watchers', async (req, res, next) => {
    try {
      const input = validateWatcherPayload(req.body);
      const shouldStart = input.enabled;
      const watcher = await db.createWatcher({ ...input, enabled: false });
      if (shouldStart) await watcherManager.start(watcher.id);
      const saved = await db.getWatcher(watcher.id);
      res.status(201).json({ watcher: { ...saved, status: watcherManager.getStatus(saved.id) } });
    } catch (error) {
      next(error);
    }
  });

  router.put('/watchers/:id', async (req, res, next) => {
    try {
      const existing = await db.getWatcher(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Watcher not found.' });
      const input = validateWatcherPayload({
        ...req.body,
        password: req.body.password || undefined,
        privateKey: req.body.privateKey || undefined
      });
      const watcher = await db.updateWatcher(req.params.id, input);
      if (input.enabled) {
        await watcherManager.start(req.params.id);
      } else {
        await watcherManager.stop(req.params.id);
      }
      const saved = await db.getWatcher(watcher.id);
      res.json({ watcher: { ...saved, status: watcherManager.getStatus(saved.id) } });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/watchers/:id', async (req, res, next) => {
    try {
      await watcherManager.remove(req.params.id);
      const deleted = await db.deleteWatcher(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Watcher not found.' });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post('/watchers/:id/start', async (req, res, next) => {
    try {
      const status = await watcherManager.start(req.params.id);
      res.json({ status });
    } catch (error) {
      next(error);
    }
  });

  router.post('/watchers/:id/stop', async (req, res, next) => {
    try {
      const status = await watcherManager.stop(req.params.id);
      res.json({ status });
    } catch (error) {
      next(error);
    }
  });

  router.post('/watchers/:id/test-connection', async (req, res, next) => {
    try {
      const watcher = await db.getWatcher(req.params.id, { includeSecrets: true });
      if (!watcher) return res.status(404).json({ error: 'Watcher not found.' });
      res.json(await testRemoteConnection(watcher));
    } catch (error) {
      next(error);
    }
  });

  router.post('/watchers/:id/test-discord', async (req, res, next) => {
    try {
      const watcher = await db.getWatcher(req.params.id);
      if (!watcher) return res.status(404).json({ error: 'Watcher not found.' });
      await discordService.send(
        watcher.discordChannel,
        discordService.formatLogLine(watcher.name, 'Test message from Discord Remote Log Watcher.')
      );
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/watchers/:id/clear-channel', async (req, res, next) => {
    try {
      const watcher = await db.getWatcher(req.params.id);
      if (!watcher) return res.status(404).json({ error: 'Watcher not found.' });
      const deleted = await discordService.clearRecentMessages(
        watcher.discordChannel,
        req.body?.limit || 100
      );
      res.json({ ok: true, deleted });
    } catch (error) {
      next(error);
    }
  });

  router.post('/watchers/:id/reset-webhook', async (req, res, next) => {
    try {
      const watcher = await db.resetWebhookToken(req.params.id);
      if (!watcher) return res.status(404).json({ error: 'Watcher not found.' });
      res.json({ watcher: { ...watcher, status: watcherManager.getStatus(watcher.id) } });
    } catch (error) {
      next(error);
    }
  });

  router.get('/status', (req, res) => {
    res.json({ statuses: watcherManager.getStatuses() });
  });

  app.use('/api', router);

  app.use((error, req, res, next) => {
    console.error(error);
    res.status(400).json({ error: error.message || 'Unexpected error.' });
  });
}

module.exports = registerRoutes;
