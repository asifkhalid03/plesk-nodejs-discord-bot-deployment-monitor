const path = require('path');
require('dotenv').config();

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
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  discordBotToken: process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || '',
  discordGuildId: process.env.DISCORD_GUILD_ID || process.env.GUILD_ID || '',
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
  compressLargeLogAttachments: booleanEnv('COMPRESS_LARGE_LOG_ATTACHMENTS', true),
  trustProxy: booleanEnv('TRUST_PROXY', false),
  ipRestrict: booleanEnv('IP_RESTRICT', false),
  ipAllowlist: listEnv('IP_ALLOWLIST'),
  uiLoginEmail: process.env.UI_LOGIN_EMAIL || '',
  uiLoginPassword: process.env.UI_LOGIN_PASSWORD || '',
  uiSessionSecret: process.env.UI_SESSION_SECRET || process.env.ENCRYPTION_KEY || ''
};
