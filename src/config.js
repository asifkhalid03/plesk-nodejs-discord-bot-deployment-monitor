const path = require('path');
const dotenvResult = require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fileEnv = dotenvResult.parsed || {};

function stringEnv(name, { preferFile = false } = {}) {
  if (preferFile && Object.prototype.hasOwnProperty.call(fileEnv, name)) {
    return fileEnv[name];
  }
  return process.env[name] || '';
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function booleanEnv(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name]).toLowerCase());
}

function listEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

module.exports = {
  port: numberEnv('PORT', 3000),
  databasePath: process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'app.db'),
  encryptionKey: stringEnv('ENCRYPTION_KEY', { preferFile: true }),
  discordBotToken: process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || '',
  discordClientId: process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID || '',
  discordGuildId: process.env.DISCORD_GUILD_ID || process.env.GUILD_ID || '',
  discordManualStopped: booleanEnv('DISCORD_MANUAL_STOPPED', false),
  dailyReportsChannelId: process.env.DAILY_REPORTS_CHANNEL_ID || '',
  reportsDownloadChannelId: process.env.REPORTS_DOWNLOAD_CHANNEL_ID || '',
  reportBotAutoStart: booleanEnv('REPORT_BOT_AUTO_START', false),
  defaultPollIntervalSeconds: numberEnv('DEFAULT_POLL_INTERVAL_SECONDS', 5),
  maxDiscordMessageLength: numberEnv('MAX_DISCORD_MESSAGE_LENGTH', 1900),
  largeLogAttachmentLineThreshold: numberEnv('LARGE_LOG_ATTACHMENT_LINE_THRESHOLD', 60),
  deploymentBlockStartText: process.env.DEPLOYMENT_BLOCK_START_TEXT || 'Deployment started:',
  deploymentBlockEndText: process.env.DEPLOYMENT_BLOCK_END_TEXT || 'Deployment finished',
  bufferDeploymentBlocks: booleanEnv('BUFFER_DEPLOYMENT_BLOCKS', true),
  deploymentBlockIdleFlushSeconds: nonNegativeNumberEnv('DEPLOYMENT_BLOCK_IDLE_FLUSH_SECONDS', 45),
  deploymentBlockForceAttachment: booleanEnv('DEPLOYMENT_BLOCK_FORCE_ATTACHMENT', true),
  webhookTriggerPollIntervalSeconds: numberEnv('WEBHOOK_TRIGGER_POLL_INTERVAL_SECONDS', 10),
  remoteConnectTimeoutMs: numberEnv('REMOTE_CONNECT_TIMEOUT_MS', 30000),
  ftpVerbose: booleanEnv('FTP_VERBOSE', false),
  compressLargeLogAttachments: booleanEnv('COMPRESS_LARGE_LOG_ATTACHMENTS', true),
  trustProxy: booleanEnv('TRUST_PROXY', false),
  ipRestrict: booleanEnv('IP_RESTRICT', false),
  ipAllowlist: listEnv('IP_ALLOWLIST'),
  allowRemoteSetup: booleanEnv('ALLOW_REMOTE_SETUP', false),
  uiLoginEmail: stringEnv('UI_LOGIN_EMAIL', { preferFile: true }),
  uiLoginPassword: stringEnv('UI_LOGIN_PASSWORD', { preferFile: true }),
  uiSessionSecret:
    stringEnv('UI_SESSION_SECRET', { preferFile: true }) ||
    stringEnv('ENCRYPTION_KEY', { preferFile: true })
};
