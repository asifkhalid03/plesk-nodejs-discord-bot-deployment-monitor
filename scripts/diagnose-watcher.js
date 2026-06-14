require('dotenv').config();

const db = require('../src/db');
const { createRemoteClient, resolveRemotePath } = require('../src/remoteClients');

async function main() {
  const id = Number(process.argv[2]);
  if (!Number.isInteger(id) || id < 1) {
    console.log('Usage: node scripts/diagnose-watcher.js <watcherId>');
    process.exit(1);
  }

  await db.initDb();
  const watcher = await db.getWatcher(id, { includeSecrets: true });
  if (!watcher) throw new Error(`Watcher ${id} not found.`);

  console.log(`Watcher: ${watcher.name}`);
  console.log(`Protocol: ${watcher.protocol}`);
  console.log(`Host: ${watcher.host}:${watcher.port}`);
  console.log(`Username: ${watcher.username}`);
  console.log(`Remote path: ${watcher.remotePath}`);

  const client = createRemoteClient(watcher);

  console.log('Connecting...');
  await client.connect();
  console.log('Connected.');

  try {
    console.log('Listing root...');
    const rootItems = await client.list('');
    console.log(rootItems.slice(0, 25).map((item) => `- ${item.name} (${item.size ?? '?'} bytes)`).join('\n') || '(empty)');
  } catch (error) {
    console.log(`Root list failed: ${error.message}`);
  }

  console.log('Resolving path...');
  const resolvedPath = await resolveRemotePath(client, watcher.remotePath);
  console.log(`Resolved path: ${resolvedPath}`);

  console.log('Checking file size...');
  const stat = await client.stat(resolvedPath);
  console.log(`File size: ${stat.size} bytes`);

  await client.close();
  console.log('OK');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
