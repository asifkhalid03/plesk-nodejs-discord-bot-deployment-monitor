const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const config = require('./config');
const { encryptSecret, decryptSecret } = require('./crypto');

let db;

async function initDb() {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  db = await open({ filename: config.databasePath, driver: sqlite3.Database });
  await db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS watcher_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS watchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK(protocol IN ('sftp', 'ftp')),
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT NOT NULL,
      password_encrypted TEXT,
      private_key_encrypted TEXT,
      remote_path TEXT NOT NULL,
      discord_channel TEXT NOT NULL,
      discord_enabled INTEGER NOT NULL DEFAULT 0,
      poll_interval_seconds INTEGER NOT NULL DEFAULT 5,
      enabled INTEGER NOT NULL DEFAULT 0,
      last_offset INTEGER NOT NULL DEFAULT 0,
      last_remote_path TEXT,
      partial_line TEXT NOT NULL DEFAULT '',
      auto_clear_enabled INTEGER NOT NULL DEFAULT 0,
      auto_clear_time TEXT NOT NULL DEFAULT '00:00',
      auto_clear_limit TEXT NOT NULL DEFAULT '100',
      auto_clear_last_run_date TEXT,
      webhook_token TEXT UNIQUE,
      server_deploy_webhook_url TEXT NOT NULL DEFAULT '',
      server_deploy_webhook_method TEXT NOT NULL DEFAULT 'POST',
      github_branch_filter TEXT NOT NULL DEFAULT '',
      deployment_timeout_seconds INTEGER NOT NULL DEFAULT 1800,
      deploy_webhook_retry_count INTEGER NOT NULL DEFAULT 3,
      group_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS deployment_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watcher_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      github_delivery_id TEXT,
      github_event TEXT NOT NULL DEFAULT 'push',
      github_ref TEXT,
      github_branch TEXT,
      commit_sha TEXT,
      commit_message TEXT,
      webhook_method TEXT NOT NULL DEFAULT 'POST',
      webhook_content_type TEXT NOT NULL DEFAULT 'application/json',
      webhook_body TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0,
      error_message TEXT NOT NULL DEFAULT '',
      log_start_offset INTEGER,
      log_end_offset INTEGER,
      queued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(watcher_id) REFERENCES watchers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS watcher_deployment_commands (
      watcher_id INTEGER PRIMARY KEY,
      node_bin TEXT NOT NULL DEFAULT '',
      log_path TEXT NOT NULL DEFAULT '',
      steps TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(watcher_id) REFERENCES watchers(id) ON DELETE CASCADE
    );
  `);
  await ensureColumn('watchers', 'last_remote_path', 'TEXT');
  await ensureColumn('watchers', 'discord_enabled', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('watchers', 'auto_clear_enabled', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('watchers', 'auto_clear_time', "TEXT NOT NULL DEFAULT '00:00'");
  await ensureColumn('watchers', 'auto_clear_limit', "TEXT NOT NULL DEFAULT '100'");
  await ensureColumn('watchers', 'auto_clear_last_run_date', 'TEXT');
  await ensureColumn('watchers', 'webhook_token', 'TEXT');
  await ensureColumn('watchers', 'server_deploy_webhook_url', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('watchers', 'server_deploy_webhook_method', "TEXT NOT NULL DEFAULT 'POST'");
  await ensureColumn('watchers', 'github_branch_filter', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('watchers', 'deployment_timeout_seconds', 'INTEGER NOT NULL DEFAULT 1800');
  await ensureColumn('watchers', 'deploy_webhook_retry_count', 'INTEGER NOT NULL DEFAULT 3');
  await ensureColumn('watchers', 'group_id', 'INTEGER');
  await ensureColumn('deployment_jobs', 'webhook_method', "TEXT NOT NULL DEFAULT 'POST'");
  await ensureColumn('deployment_jobs', 'webhook_content_type', "TEXT NOT NULL DEFAULT 'application/json'");
  await ensureColumn('deployment_jobs', 'webhook_body', "TEXT NOT NULL DEFAULT ''");
  const defaultGroupId = await ensureDefaultWatcherGroup();
  await db.run('UPDATE watchers SET group_id = ? WHERE group_id IS NULL', defaultGroupId);
  await db.run('UPDATE watchers SET discord_enabled = 1 WHERE discord_enabled = 0 AND discord_channel != ""');
  await backfillWebhookTokens();
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_watchers_webhook_token ON watchers(webhook_token)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_deployment_jobs_watcher_status_id ON deployment_jobs(watcher_id, status, id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_watchers_group_id ON watchers(group_id)');
  return db;
}

async function ensureColumn(tableName, columnName, definition) {
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  if (!columns.some((column) => column.name === columnName)) {
    await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function createWebhookToken() {
  return crypto.randomBytes(24).toString('base64url');
}

async function backfillWebhookTokens() {
  const rows = await db.all('SELECT id FROM watchers WHERE webhook_token IS NULL OR webhook_token = ""');
  for (const row of rows) {
    await db.run('UPDATE watchers SET webhook_token = ? WHERE id = ?', createWebhookToken(), row.id);
  }
}

async function ensureDefaultWatcherGroup() {
  let row = await db.get('SELECT id FROM watcher_groups WHERE is_default = 1 ORDER BY id ASC LIMIT 1');
  if (row) return row.id;

  row = await db.get('SELECT id FROM watcher_groups WHERE name = ?', 'Default');
  if (row) {
    await db.run('UPDATE watcher_groups SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', row.id);
    return row.id;
  }

  const result = await db.run(
    'INSERT INTO watcher_groups (name, is_default) VALUES (?, 1)',
    'Default'
  );
  return result.lastID;
}

function publicWatcherGroup(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    isDefault: Boolean(row.is_default),
    watcherCount: row.watcher_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function publicWatcher(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    username: row.username,
    hasPassword: Boolean(row.password_encrypted),
    hasPrivateKey: Boolean(row.private_key_encrypted),
    remotePath: row.remote_path,
    discordChannel: row.discord_channel,
    discordEnabled: Boolean(row.discord_enabled),
    pollIntervalSeconds: row.poll_interval_seconds,
    enabled: Boolean(row.enabled),
    lastOffset: row.last_offset,
    lastRemotePath: row.last_remote_path,
    autoClearEnabled: Boolean(row.auto_clear_enabled),
    autoClearTime: row.auto_clear_time,
    autoClearLimit: row.auto_clear_limit,
    autoClearLastRunDate: row.auto_clear_last_run_date,
    webhookToken: row.webhook_token,
    serverDeployWebhookUrl: row.server_deploy_webhook_url,
    serverDeployWebhookMethod: row.server_deploy_webhook_method || 'POST',
    githubBranchFilter: row.github_branch_filter,
    deploymentTimeoutSeconds: row.deployment_timeout_seconds,
    deployWebhookRetryCount: row.deploy_webhook_retry_count,
    groupId: row.group_id,
    groupName: row.group_name || 'Default',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function publicDeploymentJob(row) {
  if (!row) return null;
  const job = {
    id: row.id,
    watcherId: row.watcher_id,
    status: row.status,
    githubDeliveryId: row.github_delivery_id,
    githubEvent: row.github_event,
    githubRef: row.github_ref,
    githubBranch: row.github_branch,
    commitSha: row.commit_sha,
    commitMessage: row.commit_message,
    webhookMethod: row.webhook_method || 'POST',
    webhookContentType: row.webhook_content_type || 'application/json',
    webhookBody: row.webhook_body || '',
    attempts: row.attempts,
    errorMessage: row.error_message,
    logStartOffset: row.log_start_offset,
    logEndOffset: row.log_end_offset,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at
  };
  if (row.watcher_name !== undefined) {
    job.watcherName = row.watcher_name;
    job.watcherHost = row.watcher_host;
    job.watcherRemotePath = row.watcher_remote_path;
    job.groupId = row.group_id;
    job.groupName = row.group_name || 'Default';
  }
  return job;
}

function publicWatcherDeploymentCommand(row) {
  if (!row) return null;
  return {
    watcherId: row.watcher_id,
    nodeBin: row.node_bin,
    logPath: row.log_path,
    steps: row.steps,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function runtimeWatcher(row) {
  if (!row) return null;
  return {
    ...publicWatcher(row),
    password: decryptSecret(row.password_encrypted),
    privateKey: decryptSecret(row.private_key_encrypted),
    lastRemotePath: row.last_remote_path,
    partialLine: row.partial_line || ''
  };
}

async function listWatchers() {
  const rows = await db.all(
    `SELECT watchers.*, watcher_groups.name AS group_name
     FROM watchers
     LEFT JOIN watcher_groups ON watcher_groups.id = watchers.group_id
     ORDER BY watcher_groups.name COLLATE NOCASE, watchers.name COLLATE NOCASE`
  );
  return rows.map(publicWatcher);
}

async function getWatcher(id, { includeSecrets = false } = {}) {
  const row = await db.get(
    `SELECT watchers.*, watcher_groups.name AS group_name
     FROM watchers
     LEFT JOIN watcher_groups ON watcher_groups.id = watchers.group_id
     WHERE watchers.id = ?`,
    id
  );
  return includeSecrets ? runtimeWatcher(row) : publicWatcher(row);
}

async function getWatcherByWebhookToken(token) {
  const row = await db.get(
    `SELECT watchers.*, watcher_groups.name AS group_name
     FROM watchers
     LEFT JOIN watcher_groups ON watcher_groups.id = watchers.group_id
     WHERE watchers.webhook_token = ?`,
    token
  );
  return publicWatcher(row);
}

async function normalizeGroupId(groupId) {
  if (!groupId) return ensureDefaultWatcherGroup();
  const row = await db.get('SELECT id FROM watcher_groups WHERE id = ?', groupId);
  if (!row) throw new Error('Watcher group not found.');
  return row.id;
}

async function listWatcherGroups() {
  const rows = await db.all(
    `SELECT watcher_groups.*, COUNT(watchers.id) AS watcher_count
     FROM watcher_groups
     LEFT JOIN watchers ON watchers.group_id = watcher_groups.id
     GROUP BY watcher_groups.id
     ORDER BY watcher_groups.is_default DESC, watcher_groups.name COLLATE NOCASE`
  );
  return rows.map(publicWatcherGroup);
}

async function createWatcherGroup(input) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Group name is required.');
  const result = await db.run(
    'INSERT INTO watcher_groups (name, is_default) VALUES (?, 0)',
    name
  );
  const row = await db.get('SELECT * FROM watcher_groups WHERE id = ?', result.lastID);
  return publicWatcherGroup(row);
}

async function updateWatcherGroup(id, input) {
  const existing = await db.get('SELECT * FROM watcher_groups WHERE id = ?', id);
  if (!existing) return null;
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Group name is required.');
  await db.run(
    'UPDATE watcher_groups SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    name,
    id
  );
  const row = await db.get('SELECT * FROM watcher_groups WHERE id = ?', id);
  return publicWatcherGroup(row);
}

async function deleteWatcherGroup(id) {
  const existing = await db.get('SELECT * FROM watcher_groups WHERE id = ?', id);
  if (!existing) return false;
  if (existing.is_default) throw new Error('Default group cannot be deleted.');
  const defaultGroupId = await ensureDefaultWatcherGroup();
  await db.run('UPDATE watchers SET group_id = ?, updated_at = CURRENT_TIMESTAMP WHERE group_id = ?', defaultGroupId, id);
  await db.run('DELETE FROM watcher_groups WHERE id = ?', id);
  return true;
}

async function createWatcher(input) {
  const groupId = await normalizeGroupId(input.groupId);
  const result = await db.run(
    `INSERT INTO watchers (
      name, protocol, host, port, username, password_encrypted, private_key_encrypted,
      remote_path, discord_channel, discord_enabled, poll_interval_seconds, enabled,
      auto_clear_enabled, auto_clear_time, auto_clear_limit, webhook_token,
      server_deploy_webhook_url, server_deploy_webhook_method, github_branch_filter,
      deployment_timeout_seconds, deploy_webhook_retry_count, group_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.name,
    input.protocol,
    input.host,
    input.port,
    input.username,
    encryptSecret(input.password),
    encryptSecret(input.privateKey),
    input.remotePath,
    input.discordChannel,
    input.discordEnabled ? 1 : 0,
    input.pollIntervalSeconds,
    input.enabled ? 1 : 0,
    input.autoClearEnabled ? 1 : 0,
    input.autoClearTime,
    input.autoClearLimit,
    createWebhookToken(),
    input.serverDeployWebhookUrl || '',
    input.serverDeployWebhookMethod || 'POST',
    input.githubBranchFilter || '',
    input.deploymentTimeoutSeconds || 1800,
    input.deployWebhookRetryCount ?? 3,
    groupId
  );
  return getWatcher(result.lastID);
}

async function updateWatcher(id, input) {
  const existing = await db.get('SELECT * FROM watchers WHERE id = ?', id);
  if (!existing) return null;
  const groupId = await normalizeGroupId(input.groupId);

  const passwordEncrypted =
    input.password === undefined ? existing.password_encrypted : encryptSecret(input.password);
  const privateKeyEncrypted =
    input.privateKey === undefined ? existing.private_key_encrypted : encryptSecret(input.privateKey);

  await db.run(
    `UPDATE watchers SET
      name = ?, protocol = ?, host = ?, port = ?, username = ?,
      password_encrypted = ?, private_key_encrypted = ?, remote_path = ?,
      discord_channel = ?, discord_enabled = ?, poll_interval_seconds = ?, enabled = ?,
      auto_clear_enabled = ?, auto_clear_time = ?, auto_clear_limit = ?,
      server_deploy_webhook_url = ?, server_deploy_webhook_method = ?, github_branch_filter = ?,
      deployment_timeout_seconds = ?, deploy_webhook_retry_count = ?, group_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
    input.name,
    input.protocol,
    input.host,
    input.port,
    input.username,
    passwordEncrypted,
    privateKeyEncrypted,
    input.remotePath,
    input.discordChannel,
    input.discordEnabled ? 1 : 0,
    input.pollIntervalSeconds,
    input.enabled ? 1 : 0,
    input.autoClearEnabled ? 1 : 0,
    input.autoClearTime,
    input.autoClearLimit,
    input.serverDeployWebhookUrl || '',
    input.serverDeployWebhookMethod || 'POST',
    input.githubBranchFilter || '',
    input.deploymentTimeoutSeconds || 1800,
    input.deployWebhookRetryCount ?? 3,
    groupId,
    id
  );
  return getWatcher(id);
}

async function deleteWatcher(id) {
  const result = await db.run('DELETE FROM watchers WHERE id = ?', id);
  return result.changes > 0;
}

async function setEnabled(id, enabled) {
  await db.run(
    'UPDATE watchers SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    enabled ? 1 : 0,
    id
  );
  return getWatcher(id);
}

async function saveProgress(id, offset, partialLine, lastRemotePath = null) {
  await db.run(
    'UPDATE watchers SET last_offset = ?, partial_line = ?, last_remote_path = COALESCE(?, last_remote_path), updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    offset,
    partialLine || '',
    lastRemotePath,
    id
  );
}

async function markAutoClearRun(id, runDate) {
  await db.run(
    'UPDATE watchers SET auto_clear_last_run_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    runDate,
    id
  );
}

async function resetWebhookToken(id) {
  const token = createWebhookToken();
  const result = await db.run(
    'UPDATE watchers SET webhook_token = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    token,
    id
  );
  if (result.changes === 0) return null;
  return getWatcher(id);
}

async function createDeploymentJob(input) {
  const result = await db.run(
    `INSERT INTO deployment_jobs (
      watcher_id, status, github_delivery_id, github_event, github_ref, github_branch,
      commit_sha, commit_message, webhook_method, webhook_content_type, webhook_body,
      log_start_offset
    ) VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.watcherId,
    input.githubDeliveryId || '',
    input.githubEvent || 'push',
    input.githubRef || '',
    input.githubBranch || '',
    input.commitSha || '',
    input.commitMessage || '',
    input.webhookMethod || 'POST',
    input.webhookContentType || 'application/json',
    input.webhookBody || '',
    input.logStartOffset ?? null
  );
  return getDeploymentJob(result.lastID);
}

async function getDeploymentJob(id) {
  const row = await db.get('SELECT * FROM deployment_jobs WHERE id = ?', id);
  return publicDeploymentJob(row);
}

async function listDeploymentJobs(watcherId, { limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = await db.all(
    `SELECT * FROM deployment_jobs
     WHERE watcher_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    watcherId,
    safeLimit
  );
  return rows.map(publicDeploymentJob);
}

async function listPendingDeploymentJobs({ limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = await db.all(
    `SELECT
       deployment_jobs.*,
       watchers.name AS watcher_name,
       watchers.host AS watcher_host,
       watchers.remote_path AS watcher_remote_path,
       watchers.group_id AS group_id,
       watcher_groups.name AS group_name
     FROM deployment_jobs
     JOIN watchers ON watchers.id = deployment_jobs.watcher_id
     LEFT JOIN watcher_groups ON watcher_groups.id = watchers.group_id
     WHERE deployment_jobs.status IN ('queued', 'running')
     ORDER BY
       CASE deployment_jobs.status WHEN 'running' THEN 0 ELSE 1 END,
       deployment_jobs.id ASC
     LIMIT ?`,
    safeLimit
  );
  return rows.map(publicDeploymentJob);
}

async function listRunningDeploymentJobs() {
  const rows = await db.all(
    `SELECT * FROM deployment_jobs
     WHERE status = 'running'
     ORDER BY id ASC`
  );
  return rows.map(publicDeploymentJob);
}

async function getNextQueuedDeploymentJob(watcherId) {
  const row = await db.get(
    `SELECT * FROM deployment_jobs
     WHERE watcher_id = ? AND status = 'queued'
     ORDER BY id ASC
     LIMIT 1`,
    watcherId
  );
  return publicDeploymentJob(row);
}

async function getNextQueuedDeploymentJobForGroup(groupId) {
  const row = await db.get(
    `SELECT deployment_jobs.*
     FROM deployment_jobs
     JOIN watchers ON watchers.id = deployment_jobs.watcher_id
     WHERE watchers.group_id = ? AND deployment_jobs.status = 'queued'
     ORDER BY deployment_jobs.id ASC
     LIMIT 1`,
    groupId
  );
  return publicDeploymentJob(row);
}

async function getRunningDeploymentJob(watcherId) {
  const row = await db.get(
    `SELECT * FROM deployment_jobs
     WHERE watcher_id = ? AND status = 'running'
     ORDER BY id ASC
     LIMIT 1`,
    watcherId
  );
  return publicDeploymentJob(row);
}

async function getRunningDeploymentJobForGroup(groupId) {
  const row = await db.get(
    `SELECT deployment_jobs.*
     FROM deployment_jobs
     JOIN watchers ON watchers.id = deployment_jobs.watcher_id
     WHERE watchers.group_id = ? AND deployment_jobs.status = 'running'
     ORDER BY deployment_jobs.id ASC
     LIMIT 1`,
    groupId
  );
  return publicDeploymentJob(row);
}

async function markDeploymentJobRunning(id, attempts = 0) {
  await db.run(
    `UPDATE deployment_jobs
     SET status = 'running', attempts = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP, error_message = ''
     WHERE id = ?`,
    attempts,
    id
  );
  return getDeploymentJob(id);
}

async function updateDeploymentJobAttempts(id, attempts) {
  await db.run(
    'UPDATE deployment_jobs SET attempts = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    attempts,
    id
  );
  return getDeploymentJob(id);
}

async function markDeploymentJobCompleted(id, { logEndOffset = null } = {}) {
  await db.run(
    `UPDATE deployment_jobs
     SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
         error_message = '', log_end_offset = COALESCE(?, log_end_offset)
     WHERE id = ?`,
    logEndOffset,
    id
  );
  return getDeploymentJob(id);
}

async function markDeploymentJobFailed(id, errorMessage, { logEndOffset = null } = {}) {
  await db.run(
    `UPDATE deployment_jobs
     SET status = 'failed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
         error_message = ?, log_end_offset = COALESCE(?, log_end_offset)
     WHERE id = ?`,
    String(errorMessage || 'Deployment job failed.').slice(0, 2000),
    logEndOffset,
    id
  );
  return getDeploymentJob(id);
}

async function markDeploymentJobCancelled(id) {
  await db.run(
    `UPDATE deployment_jobs
     SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'queued'`,
    id
  );
  return getDeploymentJob(id);
}

async function failStaleRunningDeploymentJobs() {
  const result = await db.run(
    `UPDATE deployment_jobs
     SET status = 'failed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
         error_message = 'App restarted while deployment job was running.'
     WHERE status = 'running'`
  );
  return result.changes || 0;
}

async function getDeploymentJobSummary(watcherId) {
  const queued = await db.get(
    "SELECT COUNT(*) AS count FROM deployment_jobs WHERE watcher_id = ? AND status = 'queued'",
    watcherId
  );
  const running = await getRunningDeploymentJob(watcherId);
  const latest = await db.get(
    `SELECT * FROM deployment_jobs
     WHERE watcher_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    watcherId
  );
  return {
    queuedCount: queued?.count || 0,
    runningJob: running,
    latestJob: publicDeploymentJob(latest)
  };
}

async function getWatcherDeploymentCommand(watcherId) {
  const row = await db.get(
    'SELECT * FROM watcher_deployment_commands WHERE watcher_id = ?',
    watcherId
  );
  return publicWatcherDeploymentCommand(row);
}

async function saveWatcherDeploymentCommand(watcherId, input) {
  const nodeBin = String(input.nodeBin || '').trim();
  const logPath = String(input.logPath || '').trim();
  const steps = String(input.steps || '');

  await db.run(
    `INSERT INTO watcher_deployment_commands (watcher_id, node_bin, log_path, steps)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(watcher_id) DO UPDATE SET
       node_bin = excluded.node_bin,
       log_path = excluded.log_path,
       steps = excluded.steps,
       updated_at = CURRENT_TIMESTAMP`,
    watcherId,
    nodeBin,
    logPath,
    steps
  );

  return getWatcherDeploymentCommand(watcherId);
}

module.exports = {
  initDb,
  listWatcherGroups,
  createWatcherGroup,
  updateWatcherGroup,
  deleteWatcherGroup,
  listWatchers,
  getWatcher,
  getWatcherByWebhookToken,
  createWatcher,
  updateWatcher,
  deleteWatcher,
  setEnabled,
  saveProgress,
  markAutoClearRun,
  resetWebhookToken,
  createDeploymentJob,
  getDeploymentJob,
  listDeploymentJobs,
  listPendingDeploymentJobs,
  listRunningDeploymentJobs,
  getNextQueuedDeploymentJob,
  getNextQueuedDeploymentJobForGroup,
  getRunningDeploymentJob,
  getRunningDeploymentJobForGroup,
  markDeploymentJobRunning,
  updateDeploymentJobAttempts,
  markDeploymentJobCompleted,
  markDeploymentJobFailed,
  markDeploymentJobCancelled,
  failStaleRunningDeploymentJobs,
  getDeploymentJobSummary,
  getWatcherDeploymentCommand,
  saveWatcherDeploymentCommand
};
