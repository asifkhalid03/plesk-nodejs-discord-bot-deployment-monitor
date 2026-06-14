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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await ensureColumn('watchers', 'last_remote_path', 'TEXT');
  await ensureColumn('watchers', 'auto_clear_enabled', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('watchers', 'auto_clear_time', "TEXT NOT NULL DEFAULT '00:00'");
  await ensureColumn('watchers', 'auto_clear_limit', "TEXT NOT NULL DEFAULT '100'");
  await ensureColumn('watchers', 'auto_clear_last_run_date', 'TEXT');
  await ensureColumn('watchers', 'webhook_token', 'TEXT');
  await backfillWebhookTokens();
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_watchers_webhook_token ON watchers(webhook_token)');
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
    pollIntervalSeconds: row.poll_interval_seconds,
    enabled: Boolean(row.enabled),
    lastOffset: row.last_offset,
    lastRemotePath: row.last_remote_path,
    autoClearEnabled: Boolean(row.auto_clear_enabled),
    autoClearTime: row.auto_clear_time,
    autoClearLimit: row.auto_clear_limit,
    autoClearLastRunDate: row.auto_clear_last_run_date,
    webhookToken: row.webhook_token,
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
  const rows = await db.all('SELECT * FROM watchers ORDER BY name COLLATE NOCASE');
  return rows.map(publicWatcher);
}

async function getWatcher(id, { includeSecrets = false } = {}) {
  const row = await db.get('SELECT * FROM watchers WHERE id = ?', id);
  return includeSecrets ? runtimeWatcher(row) : publicWatcher(row);
}

async function getWatcherByWebhookToken(token) {
  const row = await db.get('SELECT * FROM watchers WHERE webhook_token = ?', token);
  return publicWatcher(row);
}

async function createWatcher(input) {
  const result = await db.run(
    `INSERT INTO watchers (
      name, protocol, host, port, username, password_encrypted, private_key_encrypted,
      remote_path, discord_channel, poll_interval_seconds, enabled,
      auto_clear_enabled, auto_clear_time, auto_clear_limit, webhook_token
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.name,
    input.protocol,
    input.host,
    input.port,
    input.username,
    encryptSecret(input.password),
    encryptSecret(input.privateKey),
    input.remotePath,
    input.discordChannel,
    input.pollIntervalSeconds,
    input.enabled ? 1 : 0,
    input.autoClearEnabled ? 1 : 0,
    input.autoClearTime,
    input.autoClearLimit,
    createWebhookToken()
  );
  return getWatcher(result.lastID);
}

async function updateWatcher(id, input) {
  const existing = await db.get('SELECT * FROM watchers WHERE id = ?', id);
  if (!existing) return null;

  const passwordEncrypted =
    input.password === undefined ? existing.password_encrypted : encryptSecret(input.password);
  const privateKeyEncrypted =
    input.privateKey === undefined ? existing.private_key_encrypted : encryptSecret(input.privateKey);

  await db.run(
    `UPDATE watchers SET
      name = ?, protocol = ?, host = ?, port = ?, username = ?,
      password_encrypted = ?, private_key_encrypted = ?, remote_path = ?,
      discord_channel = ?, poll_interval_seconds = ?, enabled = ?,
      auto_clear_enabled = ?, auto_clear_time = ?, auto_clear_limit = ?,
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
    input.pollIntervalSeconds,
    input.enabled ? 1 : 0,
    input.autoClearEnabled ? 1 : 0,
    input.autoClearTime,
    input.autoClearLimit,
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

module.exports = {
  initDb,
  listWatchers,
  getWatcher,
  getWatcherByWebhookToken,
  createWatcher,
  updateWatcher,
  deleteWatcher,
  setEnabled,
  saveProgress,
  markAutoClearRun,
  resetWebhookToken
};
