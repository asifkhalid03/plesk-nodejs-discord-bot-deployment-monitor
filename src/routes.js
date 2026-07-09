const express = require('express');
const db = require('./db');
const { testRemoteConnection } = require('./remoteClients');

function validateWatcherPayload(body, { partial = false } = {}) {
  const required = ['name', 'protocol', 'host', 'port', 'username', 'remotePath'];
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

  const discordChannel = String(body.discordChannel || '').trim();
  const discordEnabled = Boolean(body.discordEnabled);
  const autoClearEnabled = Boolean(body.autoClearEnabled);
  if ((discordEnabled || autoClearEnabled) && !discordChannel) {
    throw new Error('discordChannel is required when Discord is enabled for a watcher.');
  }

  const autoClearLimit = String(body.autoClearLimit || '100').trim().toLowerCase();
  if (autoClearLimit !== 'all' && (!/^\d+$/.test(autoClearLimit) || Number(autoClearLimit) < 1)) {
    throw new Error('autoClearLimit must be a positive number or "all".');
  }

  const serverDeployWebhookUrl = String(body.serverDeployWebhookUrl || '').trim();
  if (serverDeployWebhookUrl) {
    let parsedUrl;
    try {
      parsedUrl = new URL(serverDeployWebhookUrl);
    } catch (error) {
      throw new Error('serverDeployWebhookUrl must be a valid URL.');
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('serverDeployWebhookUrl must use http or https.');
    }
  }

  const githubBranchFilter = String(body.githubBranchFilter || '')
    .trim()
    .replace(/^refs\/heads\//, '');

  const serverDeployWebhookMethod = String(body.serverDeployWebhookMethod || 'POST').trim().toUpperCase();
  if (!['GET', 'POST'].includes(serverDeployWebhookMethod)) {
    throw new Error('serverDeployWebhookMethod must be GET or POST.');
  }

  const deploymentTimeoutSeconds = Number(body.deploymentTimeoutSeconds || 1800);
  if (!Number.isInteger(deploymentTimeoutSeconds) || deploymentTimeoutSeconds < 30) {
    throw new Error('deploymentTimeoutSeconds must be at least 30.');
  }

  const deployWebhookRetryCount = Number(body.deployWebhookRetryCount ?? 3);
  if (!Number.isInteger(deployWebhookRetryCount) || deployWebhookRetryCount < 0 || deployWebhookRetryCount > 10) {
    throw new Error('deployWebhookRetryCount must be between 0 and 10.');
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
    discordChannel,
    discordEnabled,
    pollIntervalSeconds,
    enabled: Boolean(body.enabled),
    autoClearEnabled: autoClearEnabled && discordEnabled,
    autoClearTime,
    autoClearLimit,
    serverDeployWebhookUrl,
    serverDeployWebhookMethod,
    githubBranchFilter,
    deploymentTimeoutSeconds,
    deployWebhookRetryCount
  };
}

function parseWebhookPayload(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = String(req.body || '').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    const params = new URLSearchParams(raw);
    const payload = params.get('payload');
    if (!payload) throw new Error('Webhook payload must be JSON.');
    return JSON.parse(payload);
  }
}

function branchFromGitRef(ref) {
  const value = String(ref || '').trim();
  return value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
}

function commitInfoFromPayload(payload) {
  const headCommit = payload?.head_commit || {};
  const commits = Array.isArray(payload?.commits) ? payload.commits : [];
  const fallback = commits.length ? commits[commits.length - 1] : {};
  return {
    sha: headCommit.id || fallback.id || payload?.after || '',
    message: headCommit.message || fallback.message || ''
  };
}

function rawWebhookBody(req, payload) {
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (typeof req.body === 'string') return req.body;
  return JSON.stringify(payload || {});
}

function registerRoutes(app, watcherManager, discordService, reportBotService) {
  const router = express.Router();

  async function decorateWatcher(watcher) {
    return {
      ...watcher,
      status: watcherManager.getStatus(watcher.id),
      jobSummary: await watcherManager.getJobSummary(watcher.id)
    };
  }

  async function handleGithubWebhook(req, res, next) {
    try {
      const watcher = await db.getWatcherByWebhookToken(req.params.token);
      if (!watcher) return res.status(404).json({ error: 'Webhook not found.' });

      const event = String(req.get('x-github-event') || '').toLowerCase();
      if (event !== 'push') {
        return res.status(202).json({
          ok: true,
          ignored: true,
          reason: 'Only GitHub push events enqueue deployments.'
        });
      }

      const payload = parseWebhookPayload(req);
      const ref = String(payload.ref || '');
      const branch = branchFromGitRef(ref);
      const filter = watcher.githubBranchFilter || '';
      if (filter && filter !== branch && filter !== ref) {
        return res.status(202).json({
          ok: true,
          ignored: true,
          reason: `Push ref ${ref || '(empty)'} does not match branch filter ${filter}.`
        });
      }

      const commit = commitInfoFromPayload(payload);
      const result = await watcherManager.enqueueDeployment(watcher.id, {
        githubDeliveryId: req.get('x-github-delivery') || '',
        githubEvent: event,
        githubRef: ref,
        githubBranch: branch,
        commitSha: commit.sha,
        commitMessage: commit.message,
        webhookMethod: req.method,
        webhookContentType: req.get('content-type') || 'application/json',
        webhookBody: rawWebhookBody(req, payload)
      });
      res.status(202).json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  app.get('/hooks/:token', (req, res) => {
    res.status(405).json({
      ok: false,
      error: 'Use POST with a GitHub push webhook payload to enqueue a deployment.'
    });
  });
  app.post('/hooks/:token', handleGithubWebhook);

  router.get('/watchers', async (req, res, next) => {
    try {
      const watchers = await db.listWatchers();
      res.json({
        watchers: await Promise.all(watchers.map((watcher) => decorateWatcher(watcher)))
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/jobs/pending', async (req, res, next) => {
    try {
      const jobs = await db.listPendingDeploymentJobs({ limit: req.query.limit });
      res.json({
        jobs,
        count: jobs.length
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
      res.status(201).json({ watcher: await decorateWatcher(saved) });
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
      res.json({ watcher: await decorateWatcher(saved) });
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

  router.get('/watchers/:id/logs', async (req, res, next) => {
    try {
      const watcher = await db.getWatcher(req.params.id);
      if (!watcher) return res.status(404).json({ error: 'Watcher not found.' });
      if (req.query.remote === '1') {
        res.json(await watcherManager.getRemoteLogTail(req.params.id, { maxBytes: req.query.maxBytes }));
        return;
      }
      res.json(watcherManager.getLogs(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  router.get('/watchers/:id/jobs', async (req, res, next) => {
    try {
      const watcher = await db.getWatcher(req.params.id);
      if (!watcher) return res.status(404).json({ error: 'Watcher not found.' });
      const jobs = await watcherManager.listJobs(req.params.id, { limit: req.query.limit });
      res.json({
        jobs,
        summary: await watcherManager.getJobSummary(req.params.id)
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/watchers/:id/jobs/:jobId/cancel', async (req, res, next) => {
    try {
      const job = await watcherManager.cancelJob(req.params.id, req.params.jobId);
      res.json({
        job,
        summary: await watcherManager.getJobSummary(req.params.id)
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/watchers/:id/test-discord', async (req, res, next) => {
    try {
      const watcher = await db.getWatcher(req.params.id);
      if (!watcher) return res.status(404).json({ error: 'Watcher not found.' });
      if (!watcher.discordEnabled) return res.status(400).json({ error: 'Discord is disabled for this watcher.' });
      if (!watcher.discordChannel) return res.status(400).json({ error: 'Discord channel is not configured for this watcher.' });
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
      if (!watcher.discordEnabled) return res.status(400).json({ error: 'Discord is disabled for this watcher.' });
      if (!watcher.discordChannel) return res.status(400).json({ error: 'Discord channel is not configured for this watcher.' });
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
      res.json({ watcher: await decorateWatcher(watcher) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/status', (req, res) => {
    res.json({ statuses: watcherManager.getStatuses() });
  });

  router.get('/discord/status', (req, res) => {
    res.json({ status: discordService.getStatus() });
  });

  router.get('/report-bot/status', (req, res) => {
    res.json({ status: reportBotService.getStatus() });
  });

  router.post('/report-bot/start', async (req, res, next) => {
    try {
      res.json({ status: await reportBotService.start() });
    } catch (error) {
      next(error);
    }
  });

  router.post('/report-bot/stop', async (req, res, next) => {
    try {
      res.json({ status: await reportBotService.stop() });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', router);

  app.use((error, req, res, next) => {
    console.error(error);
    res.status(400).json({ error: error.message || 'Unexpected error.' });
  });
}

module.exports = registerRoutes;
