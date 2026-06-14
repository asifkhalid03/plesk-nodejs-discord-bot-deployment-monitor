const {
  AttachmentBuilder,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');
const PDFDocument = require('pdfkit');
const config = require('./config');

function formatDateForFilename(date) {
  return date.toISOString().split('T')[0];
}

function isSameDate(messageDate, targetDate) {
  return (
    messageDate.getFullYear() === targetDate.getFullYear() &&
    messageDate.getMonth() === targetDate.getMonth() &&
    messageDate.getDate() === targetDate.getDate()
  );
}

class ReportBotService {
  constructor(discordService) {
    this.discordService = discordService;
    this.enabled = false;
    this.startedAt = null;
    this.lastError = '';
    this.commandsRegistered = false;
    this.boundInteractionHandler = (interaction) => {
      this.handleInteraction(interaction).catch((error) => {
        console.error('Report bot interaction error:', error);
      });
    };
    this.attachedClient = null;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      startedAt: this.startedAt,
      lastError: this.lastError,
      commandsRegistered: this.commandsRegistered,
      configured: this.isConfigured()
    };
  }

  isConfigured() {
    return Boolean(
      config.discordBotToken &&
      config.discordClientId &&
      config.discordGuildId &&
      config.dailyReportsChannelId &&
      config.reportsDownloadChannelId
    );
  }

  async start() {
    if (!this.isConfigured()) {
      throw new Error('Report bot is missing CLIENT_ID, GUILD_ID, DAILY_REPORTS_CHANNEL_ID, or REPORTS_DOWNLOAD_CHANNEL_ID.');
    }

    const client = await this.discordService.waitUntilReady();
    if (this.enabled) return this.getStatus();

    await this.registerCommands();
    if (this.attachedClient !== client) {
      if (this.attachedClient) this.attachedClient.off('interactionCreate', this.boundInteractionHandler);
      client.on('interactionCreate', this.boundInteractionHandler);
      this.attachedClient = client;
    }

    this.enabled = true;
    this.startedAt = new Date().toISOString();
    this.lastError = '';
    return this.getStatus();
  }

  async stop() {
    this.enabled = false;
    this.startedAt = null;
    return this.getStatus();
  }

  async registerCommands() {
    const rest = new REST({ version: '10' }).setToken(config.discordBotToken);
    await rest.put(
      Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId),
      { body: this.buildCommands() }
    );
    this.commandsRegistered = true;
  }

  buildCommands() {
    return [
      new SlashCommandBuilder()
        .setName('today-report')
        .setDescription('Compile and download all reports from today'),
      new SlashCommandBuilder()
        .setName('yesterday-report')
        .setDescription('Compile and download all reports from yesterday'),
      new SlashCommandBuilder()
        .setName('custom-report')
        .setDescription('Download reports from a specific date')
        .addStringOption((option) =>
          option
            .setName('date')
            .setDescription('Date in format YYYY-MM-DD')
            .setRequired(true)
        ),
      new SlashCommandBuilder()
        .setName('user-report')
        .setDescription('Get reports filtered by specific username(s)')
        .addStringOption((option) =>
          option
            .setName('usernames')
            .setDescription('Usernames separated by commas, e.g. mak, usama')
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((option) =>
          option
            .setName('date')
            .setDescription('Optional date in format YYYY-MM-DD')
            .setRequired(false)
        ),
      new SlashCommandBuilder()
        .setName('report-help')
        .setDescription('Show report bot commands')
    ].map((command) => command.toJSON());
  }

  async handleInteraction(interaction) {
    if (interaction.isAutocomplete()) {
      await this.handleAutocomplete(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (!this.isReportCommand(interaction.commandName)) return;

    if (!this.enabled) {
      await interaction.reply({ content: 'Report bot is stopped from the web UI.', flags: 64 });
      return;
    }

    if (interaction.channelId !== config.reportsDownloadChannelId) {
      await interaction.reply({
        content: 'This command can only be used in the reports-download channel.',
        flags: 64
      });
      return;
    }

    try {
      await this.handleReportCommand(interaction);
    } catch (error) {
      this.lastError = error.message;
      console.error('Report command failed:', error);
      const errorMessage = {
        content: 'An error occurred while processing the report. Please try again.',
        flags: 64
      };
      if (interaction.deferred) await interaction.editReply(errorMessage);
      else await interaction.reply(errorMessage);
    }
  }

  isReportCommand(commandName) {
    return ['today-report', 'yesterday-report', 'custom-report', 'user-report', 'report-help'].includes(commandName);
  }

  async handleAutocomplete(interaction) {
    if (interaction.commandName !== 'user-report' || !this.enabled) return;

    try {
      const channel = await this.discordService.client.channels.fetch(config.dailyReportsChannelId);
      const focusedValue = String(interaction.options.getFocused() || '').toLowerCase().trim();
      const messages = await channel.messages.fetch({ limit: 100 });
      const uniqueUsers = new Map();

      messages.forEach((message) => {
        if (!message.author.bot) {
          uniqueUsers.set(message.author.id, {
            username: message.author.username,
            displayName: message.author.displayName || message.author.username
          });
        }
      });

      let choices = Array.from(uniqueUsers.values()).map((user) => ({
        name: user.displayName,
        value: user.username
      }));

      if (focusedValue) {
        choices = choices.filter((choice) =>
          choice.name.toLowerCase().includes(focusedValue) ||
          choice.value.toLowerCase().includes(focusedValue)
        );
      }

      await interaction.respond(choices.slice(0, 25));
    } catch (error) {
      console.error('Report autocomplete failed:', error);
      await interaction.respond([]).catch(() => {});
    }
  }

  async handleReportCommand(interaction) {
    const dailyReportsChannel = await this.discordService.client.channels.fetch(config.dailyReportsChannelId);
    if (!dailyReportsChannel) {
      await interaction.reply({ content: 'Could not find the daily-reports channel.', flags: 64 });
      return;
    }

    if (interaction.commandName === 'report-help') {
      await this.sendHelp(interaction);
      return;
    }

    if (interaction.commandName === 'user-report') {
      await this.sendUserReport(interaction, dailyReportsChannel);
      return;
    }

    let targetDate;
    let dateLabel;

    if (interaction.commandName === 'today-report') {
      targetDate = new Date();
      dateLabel = 'Today';
    } else if (interaction.commandName === 'yesterday-report') {
      targetDate = new Date();
      targetDate.setDate(targetDate.getDate() - 1);
      dateLabel = 'Yesterday';
    } else if (interaction.commandName === 'custom-report') {
      const dateStr = interaction.options.getString('date');
      targetDate = new Date(dateStr);
      if (Number.isNaN(targetDate.getTime())) {
        await interaction.reply({ content: 'Invalid date format. Use YYYY-MM-DD.', flags: 64 });
        return;
      }
      dateLabel = formatDateForFilename(targetDate);
    }

    await interaction.deferReply();
    const messages = await this.fetchMessagesFromDate(dailyReportsChannel, targetDate);
    await this.sendReportFiles(interaction, messages, targetDate, `${dateLabel}'s Reports`, 'daily-reports');
  }

  async sendHelp(interaction) {
    const embed = new EmbedBuilder()
      .setColor(0x2764d9)
      .setTitle('Daily Reports Commands')
      .setDescription('Generate TXT and PDF reports from the daily reports channel.')
      .addFields(
        { name: '/today-report', value: 'Get all reports submitted today.' },
        { name: '/yesterday-report', value: 'Get all reports from yesterday.' },
        { name: '/custom-report', value: 'Get reports from a specific date.' },
        { name: '/user-report', value: 'Get reports for specific users.' }
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  }

  async sendUserReport(interaction, dailyReportsChannel) {
    const usernamesStr = interaction.options.getString('usernames');
    const dateStr = interaction.options.getString('date');
    const usernames = usernamesStr.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);

    await interaction.deferReply();

    let allMessages;
    let reportDate = new Date();
    if (dateStr) {
      reportDate = new Date(dateStr);
      if (Number.isNaN(reportDate.getTime())) {
        await interaction.editReply({ content: 'Invalid date format. Use YYYY-MM-DD.' });
        return;
      }
      allMessages = await this.fetchMessagesFromDate(dailyReportsChannel, reportDate);
    } else {
      allMessages = await this.fetchRecentMessages(dailyReportsChannel, 50);
    }

    const messages = allMessages.filter((message) => {
      const username = message.author.username.toLowerCase();
      const displayName = message.author.displayName?.toLowerCase() || '';
      const tag = message.author.tag.toLowerCase();
      return usernames.some((name) => username.includes(name) || displayName.includes(name) || tag.includes(name));
    });

    await this.sendReportFiles(
      interaction,
      messages,
      reportDate,
      `Reports for ${usernamesStr}`,
      `user-reports-${usernames.join('-')}-${dateStr || 'all-time'}`,
      [
        { name: 'Users', value: usernamesStr, inline: false },
        { name: 'Total Checked', value: String(allMessages.length), inline: true }
      ]
    );
  }

  async fetchMessagesFromDate(channel, targetDate) {
    const messages = [];
    let lastMessageId;
    const startOfTargetDate = new Date(targetDate);
    startOfTargetDate.setHours(0, 0, 0, 0);

    for (let batch = 0; batch < 100; batch++) {
      const options = { limit: 100 };
      if (lastMessageId) options.before = lastMessageId;
      const fetchedMessages = await channel.messages.fetch(options);
      if (fetchedMessages.size === 0) break;

      let foundOlderMessage = false;
      fetchedMessages.forEach((message) => {
        if (isSameDate(message.createdAt, targetDate)) messages.push(message);
        else if (message.createdAt < startOfTargetDate) foundOlderMessage = true;
      });

      if (foundOlderMessage) break;
      lastMessageId = fetchedMessages.last().id;
    }

    return messages.reverse();
  }

  async fetchRecentMessages(channel, maxBatches) {
    const messages = [];
    let lastMessageId;
    for (let batch = 0; batch < maxBatches; batch++) {
      const options = { limit: 100 };
      if (lastMessageId) options.before = lastMessageId;
      const fetchedMessages = await channel.messages.fetch(options);
      if (fetchedMessages.size === 0) break;
      fetchedMessages.forEach((message) => messages.push(message));
      lastMessageId = fetchedMessages.last().id;
    }
    return messages.reverse();
  }

  async sendReportFiles(interaction, messages, date, title, filenamePrefix, extraFields = []) {
    const reportContent = this.formatMessagesForReport(messages, date);
    const dateStr = formatDateForFilename(date);
    const baseFilename = filenamePrefix === 'daily-reports'
      ? `daily-reports-${dateStr}`
      : filenamePrefix;

    const txtAttachment = new AttachmentBuilder(Buffer.from(reportContent, 'utf8'), {
      name: `${baseFilename}.txt`
    });
    const pdfAttachment = new AttachmentBuilder(await this.createPDFReport(messages, date), {
      name: `${baseFilename}.pdf`
    });

    const embed = new EmbedBuilder()
      .setColor(messages.length > 0 ? 0x16a34a : 0xf59e0b)
      .setTitle(title)
      .setDescription(messages.length > 0 ? `Compiled ${messages.length} report(s).` : 'No reports found.')
      .addFields(
        { name: 'Date', value: dateStr, inline: true },
        { name: 'Reports Count', value: String(messages.length), inline: true },
        ...extraFields
      )
      .setTimestamp()
      .setFooter({ text: 'Daily Reports Bot - TXT & PDF' });

    await interaction.editReply({
      embeds: [embed],
      files: messages.length > 0 ? [txtAttachment, pdfAttachment] : []
    });
  }

  formatMessagesForReport(messages, date) {
    const dateStr = formatDateForFilename(date);
    let report = '==============================================\n';
    report += `       REPORTS - ${dateStr}\n`;
    report += '==============================================\n';
    report += `Total Reports: ${messages.length}\n`;
    report += `Generated: ${new Date().toLocaleString()}\n`;
    report += '==============================================\n\n';

    if (messages.length === 0) return `${report}No reports found for this date.\n`;

    messages.forEach((message, index) => {
      const displayName = message.author.displayName || message.author.username;
      report += `\n--- Report #${index + 1} ---\n`;
      report += `Name: ${displayName} (${message.author.username})\n`;
      report += `Time: ${message.createdAt.toLocaleString()}\n`;
      report += '---\n';
      report += `${message.content || ''}\n`;

      if (message.attachments.size > 0) {
        report += '\nAttachments:\n';
        message.attachments.forEach((attachment) => {
          report += `  - ${attachment.name} (${attachment.url})\n`;
        });
      }

      report += `\n${'='.repeat(50)}\n`;
    });

    return report;
  }

  async createPDFReport(messages, date) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const dateStr = formatDateForFilename(date);
      doc.fontSize(16).font('Helvetica-Bold').text('REPORTS', { align: 'center' });
      doc.fontSize(12).font('Helvetica').text(dateStr, { align: 'center' });
      doc.moveDown();
      doc.fontSize(10).text(`Total Reports: ${messages.length}`);
      doc.text(`Generated: ${new Date().toLocaleString()}`);
      doc.moveDown();

      if (messages.length === 0) {
        doc.text('No reports found for this date.');
      } else {
        messages.forEach((message, index) => {
          const displayName = message.author.displayName || message.author.username;
          doc.fontSize(11).font('Helvetica-Bold').text(`Report #${index + 1}`, { underline: true });
          doc.fontSize(10).font('Helvetica-Bold').text('Name: ', { continued: true })
            .font('Helvetica').text(`${displayName} (${message.author.username})`);
          doc.font('Helvetica-Bold').text('Time: ', { continued: true })
            .font('Helvetica').text(message.createdAt.toLocaleString());
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(9).text(message.content || '', { width: 495 });

          if (message.attachments.size > 0) {
            doc.moveDown(0.5);
            doc.fontSize(9).font('Helvetica-Bold').text('Attachments:');
            message.attachments.forEach((attachment) => {
              doc.font('Helvetica').fontSize(8).text(`  - ${attachment.name}`, { link: attachment.url });
            });
          }

          doc.moveDown();
          doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
          doc.moveDown();
        });
      }

      doc.end();
    });
  }
}

module.exports = ReportBotService;
