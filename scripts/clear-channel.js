require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const config = require('../src/config');

function usage() {
  console.log(`
Usage:
  npm run clear-channel -- <channelId> [limit] --yes

Examples:
  npm run clear-channel -- 1439515416711004250 100 --yes
  npm run clear-channel -- 1439515416711004250 all --yes

Notes:
  - The bot needs View Channel, Read Message History, and Manage Messages.
  - Discord bulk delete only works for messages newer than 14 days.
  - "all" means keep deleting recent messages until none are left.
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const channelId = args.find((arg) => /^\d{16,25}$/.test(arg));
  const limitArg = args.find((arg) => arg === 'all' || /^\d+$/.test(arg));
  const confirmed = args.includes('--yes');

  if (!channelId || !confirmed) {
    usage();
    process.exit(channelId ? 1 : 0);
  }

  return {
    channelId,
    limit: limitArg === 'all' ? Infinity : Number(limitArg || 100)
  };
}

async function main() {
  if (!config.discordBotToken) {
    throw new Error('DISCORD_BOT_TOKEN or DISCORD_TOKEN is required.');
  }

  const { channelId, limit } = parseArgs();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  await client.login(config.discordBotToken);
  const channel = await client.channels.fetch(channelId);

  if (!channel || !channel.isTextBased()) {
    throw new Error(`Channel not found or not text-based: ${channelId}`);
  }

  let deletedTotal = 0;
  let remaining = limit;

  while (remaining > 0) {
    const batchSize = Math.min(100, remaining);
    const messages = await channel.messages.fetch({ limit: batchSize });
    if (messages.size === 0) break;

    const deleted = await channel.bulkDelete(messages, true);
    deletedTotal += deleted.size;

    if (deleted.size === 0 || limit !== Infinity) break;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  console.log(`Deleted ${deletedTotal} recent message(s) from channel ${channelId}.`);
  await client.destroy();
}

main().catch(async (error) => {
  console.error(error.message || error);
  process.exit(1);
});
