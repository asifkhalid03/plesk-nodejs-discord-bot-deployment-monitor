const { gzipSync } = require('zlib');
const Discord = require('discord.js');
const config = require('./config');

const Client = Discord.Client;
const guildTextType = Discord.ChannelType?.GuildText || 'GUILD_TEXT';

function resolveIntent(name) {
  if (Discord.GatewayIntentBits?.[name]) return Discord.GatewayIntentBits[name];
  const v13Names = {
    Guilds: 'GUILDS',
    GuildMessages: 'GUILD_MESSAGES',
    MessageContent: 'MESSAGE_CONTENT'
  };
  return Discord.Intents?.FLAGS?.[v13Names[name]];
}

function createAttachment(buffer, name) {
  if (Discord.AttachmentBuilder) return new Discord.AttachmentBuilder(buffer, { name });
  return new Discord.MessageAttachment(buffer, name);
}

function isTextChannel(channel) {
  if (!channel) return false;
  if (typeof channel.isTextBased === 'function') return channel.isTextBased();
  if (typeof channel.isText === 'function') return channel.isText();
  return channel.type === guildTextType;
}

class DiscordService {
  constructor() {
    this.client = null;
    this.ready = false;
    this.readyWaiters = [];
    this.retryTimer = null;
    this.loginInProgress = false;
    this.retryDelayMs = 5000;
    this.lastError = '';
    this.lastErrorAt = null;
    this.nextRetryAt = null;
  }

  isConfigured() {
    return Boolean(config.discordBotToken);
  }

  getStatus() {
    return {
      configured: this.isConfigured(),
      ready: this.ready,
      loginInProgress: this.loginInProgress,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      nextRetryAt: this.nextRetryAt,
      userTag: this.client?.user?.tag || null
    };
  }

  ensureConfigured() {
    if (!this.isConfigured()) {
      throw new Error('Discord is not configured. Set DISCORD_BOT_TOKEN to enable Discord features.');
    }
  }

  async start() {
    this.ensureConfigured();

    if (this.client) {
      await this.client.destroy().catch(() => {});
    }

    this.ready = false;
    this.client = new Client({
      intents: [
        resolveIntent('Guilds'),
        resolveIntent('GuildMessages'),
        resolveIntent('MessageContent')
      ].filter(Boolean)
    });

    let handledReady = false;
    const handleReady = () => {
      if (handledReady) return;
      handledReady = true;
      this.ready = true;
      this.lastError = '';
      this.lastErrorAt = null;
      this.nextRetryAt = null;
      this.retryDelayMs = 5000;
      console.log(`Discord bot logged in as ${this.client.user.tag}`);
      this.readyWaiters.splice(0).forEach((resolve) => resolve(this.client));
    };
    this.client.once('clientReady', handleReady);
    this.client.once('ready', handleReady);

    this.client.on('error', (error) => {
      this.lastError = error.message || String(error);
      this.lastErrorAt = new Date().toISOString();
      console.error('Discord client error:', error.message);
    });

    this.client.on('shardDisconnect', () => {
      this.ready = false;
      this.lastError = 'Discord shard disconnected.';
      this.lastErrorAt = new Date().toISOString();
    });

    await this.client.login(config.discordBotToken);
  }

  startInBackground() {
    if (!this.isConfigured()) {
      return;
    }

    this.tryLogin().catch((error) => {
      console.error('Discord background login failed:', error.message);
    });
  }

  async tryLogin() {
    if (this.loginInProgress || this.ready) return;
    this.loginInProgress = true;

    try {
      await this.start();
    } catch (error) {
      this.ready = false;
      this.lastError = error.message || String(error);
      this.lastErrorAt = new Date().toISOString();
      this.nextRetryAt = null;
      if (this.isPermanentLoginError(error)) {
        console.error(`Discord login failed permanently: ${error.message}`);
        return;
      }

      const delay = this.retryDelayMs;
      this.nextRetryAt = new Date(Date.now() + delay).toISOString();
      console.error(`Discord login failed: ${error.message}. Retrying in ${Math.round(delay / 1000)}s.`);
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, 60000);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.tryLogin().catch((retryError) => {
          console.error('Discord retry failed:', retryError.message);
        });
      }, delay);
    } finally {
      this.loginInProgress = false;
    }
  }

  isPermanentLoginError(error) {
    return error?.code === 'TokenInvalid' || String(error?.message || '').toLowerCase().includes('invalid token');
  }

  async stop() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
    this.ready = false;
    if (this.client) {
      await this.client.destroy().catch(() => {});
    }
  }

  async waitUntilReady(timeoutMs = 30000) {
    this.ensureConfigured();
    if (this.ready && this.client) return this.client;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Discord client is not ready yet.'));
      }, timeoutMs);
      this.readyWaiters.push((client) => {
        clearTimeout(timeout);
        resolve(client);
      });
    });
  }

  async resolveChannel(channelRef) {
    this.ensureConfigured();
    if (!this.ready) {
      throw new Error('Discord client is not ready yet.');
    }

    const ref = String(channelRef || '').trim();
    if (!ref) throw new Error('Discord channel is required.');

    if (/^\d{16,25}$/.test(ref)) {
      return this.client.channels.fetch(ref);
    }

    if (!config.discordGuildId) {
      throw new Error('Channel names require DISCORD_GUILD_ID. Use a channel ID instead.');
    }

    const guild = await this.client.guilds.fetch(config.discordGuildId);
    const channels = await guild.channels.fetch();
    return channels.find((channel) => {
      return channel && channel.name === ref.replace(/^#/, '') && channel.type === guildTextType;
    });
  }

  async send(channelRef, message) {
    const channel = await this.resolveChannel(channelRef);
    if (!isTextChannel(channel)) {
      throw new Error(`Discord channel not found or not text-based: ${channelRef}`);
    }
    return channel.send(message);
  }

  async sendPayload(channelRef, payload) {
    const channel = await this.resolveChannel(channelRef);
    if (!isTextChannel(channel)) {
      throw new Error(`Discord channel not found or not text-based: ${channelRef}`);
    }
    return channel.send(payload);
  }

  async clearRecentMessages(channelRef, limit = 100) {
    const channel = await this.resolveChannel(channelRef);
    if (!isTextChannel(channel)) {
      throw new Error(`Discord channel not found or not text-based: ${channelRef}`);
    }

    const deleteLimit = limit === 'all' ? Infinity : Number(limit || 100);
    if (deleteLimit !== Infinity && (!Number.isInteger(deleteLimit) || deleteLimit < 1)) {
      throw new Error('Clear limit must be a positive number or "all".');
    }

    let deletedTotal = 0;
    let remaining = deleteLimit;

    while (remaining > 0) {
      const batchSize = Math.min(100, remaining);
      const messages = await channel.messages.fetch({ limit: batchSize });
      if (messages.size === 0) break;

      const deleted = await channel.bulkDelete(messages, true);
      deletedTotal += deleted.size;

      if (deleted.size === 0 || deleteLimit !== Infinity) break;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    return deletedTotal;
  }

  sanitizeLogText(value) {
    return String(value).replace(/\r$/, '').replace(/```/g, "`\u200b``");
  }

  formatPrefixedLine(watcherName, line) {
    const prefix = `[${watcherName}] `;
    const clean = this.sanitizeLogText(line);
    const maxLine = Math.max(100, config.maxDiscordMessageLength - prefix.length);
    return `${prefix}${clean.slice(0, maxLine)}`;
  }

  buildLogMessages(watcherName, lines) {
    const fenceStart = '```log\n';
    const fenceEnd = '\n```';
    const maxBodyLength = config.maxDiscordMessageLength - fenceStart.length - fenceEnd.length;
    const messages = [];
    let body = '';

    for (const line of lines) {
      const formatted = this.formatPrefixedLine(watcherName, line);
      const next = body ? `${body}\n${formatted}` : formatted;

      if (next.length > maxBodyLength && body) {
        messages.push(`${fenceStart}${body}${fenceEnd}`);
        body = formatted;
      } else {
        body = next;
      }
    }

    if (body) messages.push(`${fenceStart}${body}${fenceEnd}`);
    return messages;
  }

  buildLogAttachment(watcherName, lines) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = String(watcherName).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'watcher';
    const body = lines.map((line) => this.formatPrefixedLine(watcherName, line)).join('\n');
    const buffer = Buffer.from(`${body}\n`, 'utf8');
    const compressed = config.compressLargeLogAttachments;

    return createAttachment(compressed ? gzipSync(buffer) : buffer, `${safeName}-${timestamp}.log${compressed ? '.gz' : ''}`);
  }

  splitLogBlocks(lines) {
    const blocks = [];
    let current = [];

    for (const line of lines) {
      if (String(line).includes(config.deploymentBlockStartText) && current.length > 0) {
        blocks.push(current);
        current = [];
      }
      current.push(line);
    }

    if (current.length > 0) blocks.push(current);
    return blocks;
  }

  async sendLogBlock(channelRef, watcherName, lines) {
    if (lines.length >= config.largeLogAttachmentLineThreshold) {
      await this.sendLogAttachment(channelRef, watcherName, lines);
      return;
    }

    for (const message of this.buildLogMessages(watcherName, lines)) {
      await this.send(channelRef, message);
    }
  }

  async sendLogAttachment(channelRef, watcherName, lines) {
    const nonEmptyLines = lines.filter((line) => String(line).trim());
    if (nonEmptyLines.length === 0) return 0;

    await this.sendPayload(channelRef, {
      content: `\`${watcherName}\` produced ${nonEmptyLines.length} new log lines. Full output attached${config.compressLargeLogAttachments ? ' as gzip' : ''}.`,
      files: [this.buildLogAttachment(watcherName, nonEmptyLines)]
    });

    return nonEmptyLines.length;
  }

  async sendLogLines(channelRef, watcherName, lines) {
    const nonEmptyLines = lines.filter((line) => String(line).trim());
    if (nonEmptyLines.length === 0) return 0;

    for (const block of this.splitLogBlocks(nonEmptyLines)) {
      await this.sendLogBlock(channelRef, watcherName, block);
    }

    return nonEmptyLines.length;
  }

  formatLogLine(watcherName, line) {
    return this.buildLogMessages(watcherName, [line])[0];
  }
}

module.exports = DiscordService;
