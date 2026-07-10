const db = require('./db');
const config = require('./config');
const { createRemoteClient, resolveRemotePath, isRemotePathNotFoundError } = require('./remoteClients');

const DEPLOY_WEBHOOK_BACKOFF_MS = [2000, 5000, 10000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepWithSignal(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

function splitLogLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

class WatcherRuntime {
  constructor(watcher, discordService, onStatus, options = {}) {
    this.watcher = watcher;
    this.discordService = discordService;
    this.onStatus = onStatus;
    this.options = options;
    this.onLog = options.onLog || (() => {});
    this.onFinished = options.onFinished || (() => {});
    this.client = null;
    this.timer = null;
    this.running = false;
    this.polling = false;
    this.reconnectDelayMs = 2000;
    this.currentRemotePath = null;
    this.deploymentBuffer = [];
    this.deploymentBufferUpdatedAt = 0;
    this.finishSeen = false;
    this.finishNotified = false;
    this.startAtEndCaptured = false;
  }

  status(patch) {
    this.onStatus(this.watcher.id, {
      id: this.watcher.id,
      name: this.watcher.name,
      state: patch.state || 'unknown',
      message: patch.message || '',
      connected: Boolean(this.client),
      polling: this.polling,
      lastUpdateAt: patch.lastUpdateAt,
      lastErrorAt: patch.lastErrorAt,
      lastOffset: this.watcher.lastOffset,
      ...patch
    });
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.status({ state: 'starting', message: this.options.stopWhenFinished ? 'Webhook triggered watcher' : 'Starting watcher' });
    try {
      await this.withTimeout(this.connect(), config.remoteConnectTimeoutMs, 'Remote connection timed out');
      if (!this.options.deferFirstTick) this.schedule(0);
    } catch (error) {
      this.running = false;
      await this.disconnect();
      this.status({
        state: 'error',
        message: error.message,
        connected: false,
        polling: false,
        lastErrorAt: new Date().toISOString()
      });
      throw error;
    }
  }

  async stop({ silent = false } = {}) {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flushDeploymentBuffer('watcher stopped');
    await this.disconnect();
    if (!silent) this.status({ state: 'stopped', message: 'Stopped' });
  }

  async connect() {
    await this.disconnect();
    this.client = createRemoteClient(this.watcher);
    await this.client.connect();
    try {
      this.currentRemotePath = await resolveRemotePath(this.client, this.watcher.remotePath);
    } catch (error) {
      if (!isRemotePathNotFoundError(error)) throw error;
      this.reconnectDelayMs = 2000;
      this.status({
        state: 'waiting',
        message: `Connected; waiting for remote log file ${this.watcher.remotePath}`,
        lastUpdateAt: new Date().toISOString()
      });
      return;
    }

    let stat;
    try {
      stat = await this.client.stat(this.currentRemotePath);
    } catch (error) {
      if (!isRemotePathNotFoundError(error)) throw error;
      this.reconnectDelayMs = 2000;
      this.status({
        state: 'waiting',
        message: `Connected; waiting for remote log file ${this.currentRemotePath}`,
        lastUpdateAt: new Date().toISOString()
      });
      return;
    }

    if (this.options.startAtEnd) {
      this.watcher.lastOffset = stat.size;
      this.watcher.partialLine = '';
      this.watcher.lastRemotePath = this.currentRemotePath;
      await db.saveProgress(this.watcher.id, stat.size, '', this.currentRemotePath);
      this.startAtEndCaptured = true;
    } else if (!this.watcher.lastOffset && !this.watcher.lastRemotePath) {
      this.watcher.lastOffset = stat.size;
      this.watcher.lastRemotePath = this.currentRemotePath;
      await db.saveProgress(this.watcher.id, this.watcher.lastOffset, '', this.currentRemotePath);
    } else if (this.watcher.lastRemotePath && this.watcher.lastRemotePath !== this.currentRemotePath) {
      this.watcher.lastOffset = 0;
      this.watcher.partialLine = '';
      this.watcher.lastRemotePath = this.currentRemotePath;
      await db.saveProgress(this.watcher.id, 0, '', this.currentRemotePath);
    }
    this.reconnectDelayMs = 2000;
    this.status({
      state: 'connected',
      message: `Connected to ${this.currentRemotePath}, file size ${stat.size} bytes`,
      lastUpdateAt: new Date().toISOString()
    });
  }

  async disconnect() {
    const client = this.client;
    this.client = null;
    if (client) await client.close();
  }

  schedule(delayMs) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delayMs);
  }

  async tick() {
    if (!this.running || this.polling) return;
    this.polling = true;
    this.status({ state: this.client ? 'polling' : 'reconnecting', message: 'Polling remote log' });

    try {
      if (!this.client) await this.withTimeout(this.connect(), config.remoteConnectTimeoutMs, 'Remote connection timed out');
      await this.pollOnce();
      this.polling = false;
      this.schedule(this.getPollIntervalSeconds() * 1000);
    } catch (error) {
      this.polling = false;
      await this.disconnect();
      this.status({
        state: 'error',
        message: error.message,
        lastErrorAt: new Date().toISOString()
      });
      const delay = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 60000);
      this.schedule(delay);
    }
  }

  getPollIntervalSeconds() {
    return this.options.pollIntervalSeconds || this.watcher.pollIntervalSeconds;
  }

  hasDiscordTarget() {
    return this.discordService.isConfigured() && this.watcher.discordEnabled && Boolean(this.watcher.discordChannel);
  }

  async withTimeout(promise, timeoutMs, message) {
    let timeout;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async pollOnce() {
    let resolvedPath;
    try {
      resolvedPath = await resolveRemotePath(this.client, this.watcher.remotePath);
    } catch (error) {
      if (!isRemotePathNotFoundError(error)) throw error;
      this.status({
        state: 'waiting',
        message: `Waiting for remote log file ${this.watcher.remotePath}`,
        lastUpdateAt: new Date().toISOString(),
        lastOffset: this.watcher.lastOffset || 0
      });
      return;
    }

    let offset = this.watcher.lastOffset || 0;
    let partial = this.watcher.partialLine || '';

    if (this.currentRemotePath && resolvedPath !== this.currentRemotePath) {
      offset = 0;
      partial = '';
      this.watcher.lastRemotePath = resolvedPath;
      this.status({
        state: 'polling',
        message: `Switched to latest log ${resolvedPath}`
      });
    }

    this.currentRemotePath = resolvedPath;
    let stat;
    try {
      stat = await this.client.stat(this.currentRemotePath);
    } catch (error) {
      if (!isRemotePathNotFoundError(error)) throw error;
      this.status({
        state: 'waiting',
        message: `Waiting for remote log file ${this.currentRemotePath}`,
        lastUpdateAt: new Date().toISOString(),
        lastOffset: offset
      });
      return;
    }

    if (stat.size < offset) {
      offset = 0;
      partial = '';
      this.status({
        state: 'polling',
        message: 'Remote file was truncated or rotated; reading from beginning'
      });
    }

    if (this.options.startAtEnd && !this.startAtEndCaptured) {
      offset = 0;
      partial = '';
      this.startAtEndCaptured = true;
    }

    if (stat.size === offset) {
      const flushedCount = await this.flushDeploymentBufferIfIdle();
      this.status({
        state: 'connected',
        message: flushedCount ? `Flushed ${flushedCount} buffered deployment line(s)` : 'No new log data',
        lastUpdateAt: new Date().toISOString(),
        lastOffset: offset
      });
      return;
    }

    let chunk;
    try {
      chunk = await this.client.readRange(this.currentRemotePath, offset, stat.size - 1);
    } catch (error) {
      if (!isRemotePathNotFoundError(error)) throw error;
      this.status({
        state: 'waiting',
        message: `Waiting for remote log file ${this.currentRemotePath}`,
        lastUpdateAt: new Date().toISOString(),
        lastOffset: offset
      });
      return;
    }

    const text = partial + chunk.toString('utf8');
    const endsWithNewline = /\r?\n$/.test(text);
    const lines = text.split(/\r?\n/);
    partial = endsWithNewline ? '' : lines.pop() || '';
    if (endsWithNewline && lines[lines.length - 1] === '') lines.pop();
    this.onLog(this.watcher.id, lines);

    const result = await this.handleLogLines(lines);

    this.watcher.lastOffset = stat.size;
    this.watcher.partialLine = partial;
    this.watcher.lastRemotePath = this.currentRemotePath;
    await db.saveProgress(this.watcher.id, stat.size, partial, this.currentRemotePath);
    this.status({
      state: 'connected',
      message: result.skippedCount
        ? `Skipped ${result.skippedCount} Discord line(s); Discord is not configured for this watcher`
        : result.bufferedCount
        ? `Buffered ${result.bufferedCount} deployment line(s)`
        : `Sent ${result.sentCount} line(s)`,
      lastUpdateAt: new Date().toISOString(),
      lastOffset: stat.size
    });

    if (this.options.stopWhenFinished && this.finishSeen) {
      this.status({
        state: 'connected',
        message: 'Deployment finished; stopping webhook-triggered watcher',
        lastUpdateAt: new Date().toISOString()
      });
      this.notifyFinished();
      await this.stop({ silent: this.options.silentStopWhenFinished });
    }
  }

  notifyFinished() {
    if (this.finishNotified) return;
    this.finishNotified = true;
    this.onFinished(this.watcher.id, {
      remotePath: this.currentRemotePath,
      lastOffset: this.watcher.lastOffset || 0
    });
  }

  async handleLogLines(lines) {
    const nonEmptyLineCount = lines.filter((line) => String(line).trim()).length;
    if (!this.hasDiscordTarget()) {
      if (config.deploymentBlockEndText) {
        this.finishSeen = this.finishSeen || lines.some((line) => String(line).includes(config.deploymentBlockEndText));
      }
      return { sentCount: 0, bufferedCount: 0, skippedCount: nonEmptyLineCount };
    }

    if (!config.bufferDeploymentBlocks) {
      const sentCount = await this.discordService.sendLogLines(
        this.watcher.discordChannel,
        this.watcher.name,
        lines
      );
      return { sentCount, bufferedCount: 0, skippedCount: 0 };
    }

    let sentCount = 0;
    const immediateLines = [];

    for (const line of lines) {
      if (!String(line).trim()) continue;

      const isStart = String(line).includes(config.deploymentBlockStartText);
      const isEnd = config.deploymentBlockEndText && String(line).includes(config.deploymentBlockEndText);
      if (isEnd) this.finishSeen = true;

      if (isStart) {
        sentCount += await this.flushDeploymentBuffer('new deployment started');
        this.deploymentBuffer = [line];
        this.deploymentBufferUpdatedAt = Date.now();
        continue;
      }

      if (this.deploymentBuffer.length > 0) {
        this.deploymentBuffer.push(line);
        this.deploymentBufferUpdatedAt = Date.now();

        if (isEnd) {
          sentCount += await this.flushDeploymentBuffer('deployment finished');
        }
        continue;
      }

      immediateLines.push(line);
    }

    if (immediateLines.length > 0) {
      sentCount += await this.discordService.sendLogLines(
        this.watcher.discordChannel,
        this.watcher.name,
        immediateLines
      );
    }

    return { sentCount, bufferedCount: this.deploymentBuffer.length, skippedCount: 0 };
  }

  async flushDeploymentBufferIfIdle() {
    if (this.deploymentBuffer.length === 0) return 0;
    if (config.deploymentBlockIdleFlushSeconds === 0) return 0;
    const idleMs = Date.now() - this.deploymentBufferUpdatedAt;
    if (idleMs < config.deploymentBlockIdleFlushSeconds * 1000) return 0;
    return this.flushDeploymentBuffer('deployment output idle');
  }

  async flushDeploymentBuffer(reason) {
    if (this.deploymentBuffer.length === 0) return 0;
    const lines = this.deploymentBuffer;
    this.deploymentBuffer = [];
    this.deploymentBufferUpdatedAt = 0;
    if (!this.hasDiscordTarget()) {
      this.status({
        state: 'connected',
        message: `Skipped deployment block (${reason}); Discord is not configured for this watcher`,
        lastUpdateAt: new Date().toISOString()
      });
      return 0;
    }
    const sentCount = config.deploymentBlockForceAttachment
      ? await this.discordService.sendLogAttachment(this.watcher.discordChannel, this.watcher.name, lines)
      : await this.discordService.sendLogLines(this.watcher.discordChannel, this.watcher.name, lines);
    this.status({
      state: 'connected',
      message: `Sent deployment block (${reason})`,
      lastUpdateAt: new Date().toISOString()
    });
    return sentCount;
  }
}

class WatcherManager {
  constructor(discordService) {
    this.discordService = discordService;
    this.runtimes = new Map();
    this.statuses = new Map();
    this.logBuffers = new Map();
    this.maxLogLines = 5000;
    this.autoClearTimer = null;
    this.queueProcessors = new Map();
    this.activeJobs = new Map();
  }

  async startEnabledWatchers() {
    const watchers = await db.listWatchers();
    const enabledWatchers = watchers.filter((watcher) => watcher.enabled);
    enabledWatchers.forEach((watcher) => {
      this.setStatus(watcher.id, {
        id: watcher.id,
        name: watcher.name,
        state: 'stopped',
        message: 'Webhook mode: FTP/SFTP starts only while a deployment job is running',
        connected: false,
        polling: false,
        lastUpdateAt: new Date().toISOString()
      });
    });
    this.startAutoClearScheduler();
  }

  async startDeploymentQueues() {
    await this.recoverRunningDeploymentJobs();
    const groups = await db.listWatcherGroups();
    groups.forEach((group) => {
      this.processGroupQueue(group.id).catch((error) => {
        console.error(`Deployment queue processor failed for group ${group.id}:`, error);
      });
    });
  }

  async recoverRunningDeploymentJobs() {
    const jobs = await db.listRunningDeploymentJobs();
    if (jobs.length === 0) return;

    for (const job of jobs) {
      const watcher = await db.getWatcher(job.watcherId, { includeSecrets: true });
      if (!watcher) {
        await db.markDeploymentJobFailed(job.id, 'App restarted while deployment job was running, and the watcher no longer exists.');
        continue;
      }

      try {
        const snapshot = await this.readRemoteLogSnapshot(watcher, {
          baselineSize: job.logStartOffset ?? 0,
          baselineText: null
        });
        if (this.hasDeploymentFinishMarker(snapshot.text)) {
          const completed = await db.markDeploymentJobCompleted(job.id, {
            logEndOffset: snapshot.size
          });
          this.activeJobs.set(Number(watcher.id), completed);
          this.setStatus(watcher.id, {
            id: watcher.id,
            name: watcher.name,
            state: 'stopped',
            message: `Recovered completed deployment job #${job.id} from FTP/SFTP log after restart`,
            connected: false,
            polling: false,
            lastUpdateAt: new Date().toISOString(),
            lastOffset: snapshot.size
          });
          this.activeJobs.delete(Number(watcher.id));
          continue;
        }

        await db.markDeploymentJobFailed(
          job.id,
          'App restarted while deployment job was running; finish marker was not found in the remote log.',
          { logEndOffset: snapshot.size }
        );
      } catch (error) {
        await db.markDeploymentJobFailed(
          job.id,
          `App restarted while deployment job was running; remote log recovery failed: ${error.message}`
        );
      }
    }
  }

  startAutoClearScheduler() {
    if (this.autoClearTimer) return;
    this.autoClearTimer = setInterval(() => {
      this.runAutoClearDueWatchers().catch((error) => {
        console.error('Auto clear scheduler error:', error);
      });
    }, 60000);
    this.runAutoClearDueWatchers().catch((error) => {
      console.error('Auto clear scheduler error:', error);
    });
  }

  async runAutoClearDueWatchers(now = new Date()) {
    if (!this.discordService.isConfigured()) return;

    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const currentTime = `${hh}:${mm}`;
    const today = now.toISOString().slice(0, 10);
    const watchers = await db.listWatchers();

    for (const watcher of watchers) {
      if (!watcher.autoClearEnabled) continue;
      if (!watcher.discordEnabled) continue;
      if (!watcher.discordChannel) continue;
      if (watcher.autoClearTime !== currentTime) continue;
      if (watcher.autoClearLastRunDate === today) continue;

      try {
        const deleted = await this.discordService.clearRecentMessages(
          watcher.discordChannel,
          watcher.autoClearLimit
        );
        await db.markAutoClearRun(watcher.id, today);
        this.setStatus(watcher.id, {
          message: `Auto-cleared ${deleted} channel message(s)`,
          lastUpdateAt: new Date().toISOString()
        });
      } catch (error) {
        this.setStatus(watcher.id, {
          state: 'error',
          message: `Auto clear failed: ${error.message}`,
          lastErrorAt: new Date().toISOString()
        });
      }
    }
  }

  getStatuses() {
    return Array.from(this.statuses.values());
  }

  getStatus(id) {
    return this.statuses.get(Number(id)) || {
      id: Number(id),
      state: 'stopped',
      message: 'Stopped',
      connected: false,
      polling: false
    };
  }

  setStatus(id, status) {
    const previous = this.getStatus(id);
    this.statuses.set(Number(id), { ...previous, ...status });
  }

  appendLogs(id, lines) {
    const numericId = Number(id);
    const activeJob = this.activeJobs.get(numericId);
    const entries = lines
      .filter((line) => line !== undefined)
      .map((line) => ({
        at: new Date().toISOString(),
        jobId: activeJob?.id || null,
        line: String(line)
      }));
    if (entries.length === 0) return;

    const buffer = this.logBuffers.get(numericId) || [];
    buffer.push(...entries);
    if (buffer.length > this.maxLogLines) {
      buffer.splice(0, buffer.length - this.maxLogLines);
    }
    this.logBuffers.set(numericId, buffer);
  }

  clearLogs(id) {
    this.logBuffers.set(Number(id), []);
  }

  getLogs(id) {
    const numericId = Number(id);
    const lines = this.logBuffers.get(numericId) || [];
    return {
      watcherId: numericId,
      lines,
      maxLines: this.maxLogLines,
      truncated: lines.length >= this.maxLogLines,
      status: this.getStatus(numericId),
      currentJob: this.activeJobs.get(numericId) || null
    };
  }

  async getRemoteLogTail(id, { maxBytes = 200000 } = {}) {
    const numericId = Number(id);
    const watcher = await db.getWatcher(numericId, { includeSecrets: true });
    if (!watcher) throw new Error('Watcher not found.');

    const safeMaxBytes = Math.min(Math.max(Number(maxBytes) || 200000, 4096), 1000000);
    const client = createRemoteClient(watcher);
    try {
      await client.connect();
      const resolvedPath = await resolveRemotePath(client, watcher.remotePath);
      const stat = await client.stat(resolvedPath);
      const startOffset = Math.max(0, stat.size - safeMaxBytes);
      const chunk = await client.readRange(resolvedPath, startOffset, stat.size - 1);
      let text = chunk.toString('utf8');

      if (startOffset > 0) {
        text = text.replace(/^[^\r\n]*(?:\r?\n|$)/, '');
      }

      const rawLines = text.length ? text.split(/\r?\n/) : [];
      if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();
      const now = new Date().toISOString();
      const lines = rawLines.map((line) => ({
        at: now,
        jobId: this.activeJobs.get(numericId)?.id || null,
        source: 'remote',
        line
      }));

      return {
        watcherId: numericId,
        lines,
        maxLines: lines.length,
        truncated: startOffset > 0,
        status: this.getStatus(numericId),
        currentJob: this.activeJobs.get(numericId) || null,
        remote: {
          resolvedPath,
          size: stat.size,
          startOffset,
          tailBytes: safeMaxBytes
        }
      };
    } finally {
      await client.close();
    }
  }

  async readRemoteLogSnapshot(watcher, { baselineSize = 0, baselineText = null, maxBytes = 1000000 } = {}) {
    const safeMaxBytes = Math.min(Math.max(Number(maxBytes) || 1000000, 4096), 2000000);
    const client = createRemoteClient(watcher);
    try {
      await client.connect();
      const resolvedPath = await resolveRemotePath(client, watcher.remotePath);
      const stat = await client.stat(resolvedPath);
      let startOffset = 0;
      let mode = 'full';

      if (stat.size > baselineSize) {
        startOffset = baselineSize;
        mode = 'append';
      } else if (stat.size === baselineSize && stat.size > safeMaxBytes) {
        startOffset = Math.max(0, stat.size - safeMaxBytes);
        mode = 'same-size-tail';
      }

      if (stat.size < baselineSize || stat.size <= safeMaxBytes) {
        startOffset = 0;
        mode = stat.size < baselineSize ? 'rewritten' : 'full';
      }

      const chunk = await client.readRange(resolvedPath, startOffset, stat.size - 1);
      let text = chunk.toString('utf8');
      if (startOffset > 0) {
        text = text.replace(/^[^\r\n]*(?:\r?\n|$)/, '');
      }

      const changed =
        stat.size !== baselineSize ||
        baselineText === null ||
        text !== baselineText;

      return {
        text,
        lines: splitLogLines(text),
        changed,
        mode,
        resolvedPath,
        size: stat.size,
        startOffset
      };
    } finally {
      await client.close();
    }
  }

  hasDeploymentFinishMarker(text) {
    const source = String(text || '');
    const finishMarker = config.deploymentBlockEndText || 'Deployment finished';
    if (!finishMarker) return false;
    const lastFinish = source.lastIndexOf(finishMarker);
    if (lastFinish === -1) return false;

    const startMarker = config.deploymentBlockStartText || 'Deployment started:';
    const lastStart = startMarker ? source.lastIndexOf(startMarker) : -1;
    return lastStart === -1 || lastFinish >= lastStart;
  }

  async waitForRemoteFinishMarker(watcher, job, baseline, signal) {
    const intervalMs = Math.max(Number(config.webhookTriggerPollIntervalSeconds) || 2, 1) * 1000;
    let lastErrorMessage = '';

    while (!signal?.aborted) {
      try {
        const snapshot = await this.readRemoteLogSnapshot(watcher, baseline);
        if (snapshot.changed && this.hasDeploymentFinishMarker(snapshot.text)) {
          if (snapshot.lines.length > 0) this.appendLogs(watcher.id, snapshot.lines);
          this.setStatus(watcher.id, {
            state: 'running',
            message: `Finish marker detected in FTP/SFTP log for job #${job.id}`,
            lastUpdateAt: new Date().toISOString(),
            lastOffset: snapshot.size
          });
          return {
            watcherId: watcher.id,
            remotePath: snapshot.resolvedPath,
            lastOffset: snapshot.size,
            source: 'remote-log-scan'
          };
        }
        lastErrorMessage = '';
      } catch (error) {
        lastErrorMessage = error.message;
        this.setStatus(watcher.id, {
          state: 'running',
          message: `Waiting for finish marker; remote log check failed: ${error.message}`,
          lastUpdateAt: new Date().toISOString()
        });
      }

      await sleepWithSignal(intervalMs, signal);
    }

    return {
      watcherId: watcher.id,
      remotePath: watcher.remotePath,
      lastOffset: baseline?.baselineSize,
      aborted: true,
      errorMessage: lastErrorMessage
    };
  }

  async start(id) {
    await this.stop(id, { persist: false });
    this.clearLogs(id);
    const watcher = await db.getWatcher(id, { includeSecrets: true });
    if (!watcher) throw new Error('Watcher not found.');
    const runtime = new WatcherRuntime(watcher, this.discordService, (watcherId, status) => {
      this.setStatus(watcherId, status);
    }, {
      onLog: (watcherId, lines) => this.appendLogs(watcherId, lines)
    });
    this.runtimes.set(Number(id), runtime);
    try {
      await runtime.start();
      await db.setEnabled(id, true);
    } catch (error) {
      this.runtimes.delete(Number(id));
      await db.setEnabled(id, false);
      throw error;
    }
    return this.getStatus(id);
  }

  async enqueueDeployment(id, jobInput) {
    const watcher = await db.getWatcher(id);
    if (!watcher) throw new Error('Watcher not found.');

    const job = await db.createDeploymentJob({
      watcherId: watcher.id,
      ...jobInput,
      logStartOffset: watcher.lastOffset || 0
    });

    if (!watcher.serverDeployWebhookUrl) {
      const failedJob = await db.markDeploymentJobFailed(
        job.id,
        'Server deploy webhook URL is required before GitHub push webhooks can run deployments.'
      );
      this.setStatus(watcher.id, {
        id: watcher.id,
        name: watcher.name,
        state: 'error',
        message: `Deployment job #${job.id} failed: server deploy webhook URL is missing`,
        connected: false,
        polling: false,
        lastErrorAt: new Date().toISOString()
      });
      return {
        job: failedJob,
        summary: await db.getDeploymentJobSummary(watcher.id)
      };
    }

    this.processGroupQueue(watcher.groupId).catch((error) => {
      console.error(`Deployment queue processor failed for group ${watcher.groupId}:`, error);
    });
    return {
      job,
      summary: await db.getDeploymentJobSummary(watcher.id)
    };
  }

  async getJobSummary(id) {
    return db.getDeploymentJobSummary(id);
  }

  async listJobs(id, options) {
    const watcher = await db.getWatcher(id);
    if (!watcher) throw new Error('Watcher not found.');
    return db.listDeploymentJobs(id, options);
  }

  async cancelJob(watcherId, jobId) {
    const job = await db.getDeploymentJob(jobId);
    if (!job || Number(job.watcherId) !== Number(watcherId)) throw new Error('Deployment job not found.');
    if (job.status !== 'queued') {
      throw new Error('Only queued deployment jobs can be cancelled.');
    }
    return db.markDeploymentJobCancelled(job.id);
  }

  async processQueue(id) {
    const watcher = await db.getWatcher(id);
    if (!watcher) throw new Error('Watcher not found.');
    return this.processGroupQueue(watcher.groupId);
  }

  async processGroupQueue(groupId) {
    const numericId = Number(groupId);
    if (this.queueProcessors.has(numericId)) return this.queueProcessors.get(numericId);

    const processor = this.runQueueLoop(numericId)
      .catch((error) => {
        console.error(`Deployment queue loop failed for group ${numericId}:`, error);
      })
      .finally(() => {
        this.queueProcessors.delete(numericId);
      });
    this.queueProcessors.set(numericId, processor);
    return processor;
  }

  async runQueueLoop(groupId) {
    while (true) {
      const running = await db.getRunningDeploymentJobForGroup(groupId);
      if (running) return;

      const job = await db.getNextQueuedDeploymentJobForGroup(groupId);
      if (!job) break;

      const watcher = await db.getWatcher(job.watcherId, { includeSecrets: true });
      if (!watcher) {
        await db.markDeploymentJobFailed(job.id, 'Watcher was deleted before the deployment job could run.');
        continue;
      }

      await this.runDeploymentJob(watcher, job);
    }

    await this.stopIdleGroupRuntimes(groupId);
  }

  async stopIdleGroupRuntimes(groupId) {
    const watchers = await db.listWatchers();
    const groupWatchers = watchers.filter((watcher) => Number(watcher.groupId) === Number(groupId));

    for (const watcher of groupWatchers) {
      const numericId = Number(watcher.id);
      if (this.activeJobs.has(numericId)) continue;
      if (!this.runtimes.has(numericId)) continue;

      await this.stop(numericId, { persist: false });
      this.setStatus(numericId, {
        id: numericId,
        name: watcher.name,
        state: 'stopped',
        message: 'Queue finished; FTP/SFTP connection closed',
        connected: false,
        polling: false,
        lastUpdateAt: new Date().toISOString()
      });
    }
  }

  async runDeploymentJob(watcher, job) {
    const numericId = Number(watcher.id);
    let runtime = null;
    let timeoutHandle = null;
    let finishScanController = null;

    await db.markDeploymentJobRunning(job.id, 0);
    const activeJob = await db.getDeploymentJob(job.id);
    this.activeJobs.set(numericId, activeJob);
    this.clearLogs(numericId);
    await this.stop(numericId, { persist: false });

    this.setStatus(numericId, {
      id: numericId,
      name: watcher.name,
      state: 'starting',
      message: `Queued deployment job #${job.id} starting`,
      connected: false,
      polling: false,
      lastUpdateAt: new Date().toISOString()
    });

    try {
      if (this.discordService.isConfigured() && watcher.discordEnabled && watcher.discordChannel) {
        await this.clearChannelForDeployment(watcher);
      }

      let finishResolve;
      const finishPromise = new Promise((resolve) => {
        finishResolve = resolve;
      });

      runtime = new WatcherRuntime(
        watcher,
        this.discordService,
        (watcherId, status) => {
          this.setStatus(watcherId, status);
          if (status.state === 'stopped') this.runtimes.delete(Number(watcherId));
        },
        {
          stopWhenFinished: true,
          deferFirstTick: true,
          silentStopWhenFinished: true,
          startAtEnd: true,
          pollIntervalSeconds: config.webhookTriggerPollIntervalSeconds,
          onLog: (watcherId, lines) => this.appendLogs(watcherId, lines),
          onFinished: (watcherId, info) => {
            finishResolve({ watcherId, ...info });
          }
        }
      );

      this.runtimes.set(numericId, runtime);
      await runtime.start();
      await runtime.pollOnce();
      runtime.schedule(runtime.getPollIntervalSeconds() * 1000);

      let baseline = {
        baselineSize: runtime.watcher.lastOffset || 0,
        baselineText: null
      };
      try {
        const snapshot = await this.readRemoteLogSnapshot(watcher, {
          baselineSize: runtime.watcher.lastOffset || 0,
          baselineText: null
        });
        baseline = {
          baselineSize: snapshot.size,
          baselineText: snapshot.text
        };
      } catch (error) {
        this.setStatus(numericId, {
          state: 'running',
          message: `Unable to capture pre-deploy log baseline: ${error.message}`,
          lastUpdateAt: new Date().toISOString()
        });
      }

      await this.callServerDeployWebhook(watcher, activeJob);

      const timeoutMs = Math.max(Number(watcher.deploymentTimeoutSeconds) || 1800, 1) * 1000;
      const timeoutPromise = new Promise((resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Deployment timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
        }, timeoutMs);
      });
      finishScanController = new AbortController();
      const remoteFinishPromise = this.waitForRemoteFinishMarker(
        watcher,
        activeJob,
        baseline,
        finishScanController.signal
      );

      const finishInfo = await Promise.race([finishPromise, remoteFinishPromise, timeoutPromise]);
      finishScanController.abort();
      finishScanController = null;
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
      const completed = await db.markDeploymentJobCompleted(job.id, {
        logEndOffset: finishInfo?.lastOffset ?? watcher.lastOffset ?? null
      });
      this.activeJobs.set(numericId, completed);
      this.setStatus(numericId, {
        state: 'stopped',
        message: `Deployment job #${job.id} completed`,
        lastUpdateAt: new Date().toISOString(),
        lastOffset: finishInfo?.lastOffset
      });
    } catch (error) {
      if (finishScanController) finishScanController.abort();
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const status = this.getStatus(numericId);
      const failed = await db.markDeploymentJobFailed(job.id, error.message, {
        logEndOffset: status.lastOffset ?? watcher.lastOffset ?? null
      });
      this.activeJobs.set(numericId, failed);
      this.setStatus(numericId, {
        state: 'error',
        message: `Deployment job #${job.id} failed: ${error.message}`,
        lastErrorAt: new Date().toISOString()
      });
    } finally {
      if (runtime && this.runtimes.get(numericId) === runtime) {
        await runtime.stop({ silent: true }).catch(() => {});
        this.runtimes.delete(numericId);
      }
      this.activeJobs.delete(numericId);
    }
  }

  async callServerDeployWebhook(watcher, job) {
    const jobId = job.id;
    const retryCount = Math.max(0, Number(watcher.deployWebhookRetryCount) || 0);
    const totalAttempts = retryCount + 1;
    let lastError = null;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      await db.updateDeploymentJobAttempts(jobId, attempt);
      this.setStatus(watcher.id, {
        state: 'running',
        message: `Calling server deploy webhook for job #${jobId} (attempt ${attempt}/${totalAttempts})`,
        lastUpdateAt: new Date().toISOString()
      });

      try {
        await this.fetchDeployWebhook(watcher.serverDeployWebhookUrl, job);
        this.setStatus(watcher.id, {
          state: 'running',
          message: `Server deploy webhook accepted job #${jobId}; waiting for finish marker`,
          lastUpdateAt: new Date().toISOString()
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < totalAttempts) {
          await sleep(DEPLOY_WEBHOOK_BACKOFF_MS[Math.min(attempt - 1, DEPLOY_WEBHOOK_BACKOFF_MS.length - 1)]);
        }
      }
    }

    throw new Error(`Server deploy webhook failed after ${totalAttempts} attempt(s): ${lastError?.message || 'Unknown error'}`);
  }

  async fetchDeployWebhook(url, job) {
    const method = job.webhookMethod || 'POST';
    const body = method === 'GET' || method === 'HEAD' ? undefined : job.webhookBody || '';
    const headers = {};
    if (body !== undefined) {
      headers['Content-Type'] = job.webhookContentType || 'application/json';
    }
    if (job.githubEvent) headers['X-GitHub-Event'] = job.githubEvent;
    if (job.githubDeliveryId) headers['X-GitHub-Delivery'] = job.githubDeliveryId;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.remoteConnectTimeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        redirect: 'follow',
        signal: controller.signal
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const detail = body ? `: ${body.slice(0, 300)}` : '';
        throw new Error(`HTTP ${response.status}${detail}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async triggerWebhook(id) {
    const numericId = Number(id);
    if (this.runtimes.has(numericId)) {
      const status = this.getStatus(numericId);
      this.setStatus(numericId, {
        ...status,
        message: 'Webhook received; watcher is already running',
        lastUpdateAt: new Date().toISOString()
      });
      return this.getStatus(numericId);
    }

    const watcher = await db.getWatcher(id, { includeSecrets: true });
    if (!watcher) throw new Error('Watcher not found.');
    this.clearLogs(numericId);

    if (this.discordService.isConfigured() && watcher.discordEnabled && watcher.discordChannel) {
      await this.clearChannelForDeployment(watcher);
    }

    const runtime = new WatcherRuntime(
      watcher,
      this.discordService,
      (watcherId, status) => {
        this.setStatus(watcherId, status);
        if (status.state === 'stopped') this.runtimes.delete(Number(watcherId));
      },
      {
        stopWhenFinished: true,
        pollIntervalSeconds: config.webhookTriggerPollIntervalSeconds,
        onLog: (watcherId, lines) => this.appendLogs(watcherId, lines)
      }
    );

    this.runtimes.set(numericId, runtime);
    try {
      await runtime.start();
    } catch (error) {
      this.runtimes.delete(numericId);
      throw error;
    }
    return this.getStatus(numericId);
  }

  async clearChannelForDeployment(watcher) {
    const limit = watcher.autoClearLimit || '100';
    try {
      const deleted = await this.discordService.clearRecentMessages(watcher.discordChannel, limit);
      this.setStatus(watcher.id, {
        id: watcher.id,
        name: watcher.name,
        state: 'starting',
        message: `Cleared ${deleted} channel message(s) for new deployment`,
        connected: false,
        polling: false,
        lastUpdateAt: new Date().toISOString()
      });
    } catch (error) {
      this.setStatus(watcher.id, {
        id: watcher.id,
        name: watcher.name,
        state: 'error',
        message: `Channel clear failed: ${error.message}`,
        connected: false,
        polling: false,
        lastErrorAt: new Date().toISOString()
      });
      throw error;
    }
  }

  async stop(id, { persist = true } = {}) {
    const runtime = this.runtimes.get(Number(id));
    if (runtime) {
      await runtime.stop();
      this.runtimes.delete(Number(id));
    } else {
      this.setStatus(id, { id: Number(id), state: 'stopped', message: 'Stopped', connected: false, polling: false });
    }
    if (persist) await db.setEnabled(id, false);
    return this.getStatus(id);
  }

  async restartIfRunning(id) {
    if (this.runtimes.has(Number(id))) {
      await this.start(id);
    }
  }

  async remove(id) {
    await this.stop(id, { persist: false });
    this.statuses.delete(Number(id));
  }

  async shutdown() {
    if (this.autoClearTimer) clearInterval(this.autoClearTimer);
    this.autoClearTimer = null;
    await Promise.all(Array.from(this.runtimes.keys()).map((id) => this.stop(id, { persist: false })));
  }
}

module.exports = WatcherManager;
