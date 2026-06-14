const { Writable } = require('stream');
const path = require('path').posix;
const SftpClient = require('ssh2-sftp-client');
const ftp = require('basic-ftp');
const config = require('./config');

class RemotePathNotFoundError extends Error {
  constructor(remotePath, cause) {
    super(`Remote path not found: ${remotePath}`);
    this.name = 'RemotePathNotFoundError';
    this.code = 'REMOTE_PATH_NOT_FOUND';
    this.remotePath = remotePath;
    this.cause = cause;
  }
}

function isRemotePathNotFoundError(error) {
  if (error?.code === 'REMOTE_PATH_NOT_FOUND') return true;
  if (error?.code === 550 || error?.code === '550') return true;
  return /no such file|not found|no such path|does not exist/i.test(String(error?.message || ''));
}

function wrapRemotePathNotFound(remotePath, error) {
  if (isRemotePathNotFoundError(error)) {
    throw new RemotePathNotFoundError(remotePath, error);
  }
  throw error;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

class SftpRemoteClient {
  constructor(watcher) {
    this.watcher = watcher;
    this.client = new SftpClient();
  }

  async connect() {
    await this.client.connect({
      host: this.watcher.host,
      port: this.watcher.port,
      username: this.watcher.username,
      password: this.watcher.password || undefined,
      privateKey: this.watcher.privateKey || undefined,
      readyTimeout: 20000
    });
  }

  async stat(remotePath) {
    try {
      const info = await this.client.stat(remotePath);
      return { size: info.size };
    } catch (error) {
      wrapRemotePathNotFound(remotePath, error);
    }
  }

  async list(remoteDir) {
    const items = await this.client.list(remoteDir || '.');
    return items
      .filter((item) => item.type === '-' || item.type === undefined)
      .map((item) => ({ name: item.name, size: item.size, modifyTime: item.modifyTime }));
  }

  async readRange(remotePath, start, endInclusive) {
    if (endInclusive < start) return Buffer.alloc(0);
    try {
      const stream = await this.client.createReadStream(remotePath, {
        start,
        end: endInclusive,
        autoClose: true
      });
      return streamToBuffer(stream);
    } catch (error) {
      wrapRemotePathNotFound(remotePath, error);
    }
  }

  async close() {
    await this.client.end().catch(() => {});
  }
}

class FtpRemoteClient {
  constructor(watcher) {
    this.watcher = watcher;
    this.client = new ftp.Client(config.remoteConnectTimeoutMs);
    this.client.ftp.verbose = config.ftpVerbose;
  }

  async connect() {
    try {
      await this.client.access({
        host: this.watcher.host,
        port: this.watcher.port,
        user: this.watcher.username,
        password: this.watcher.password,
        secure: false
      });
    } catch (error) {
      throw new Error(`FTP connect failed to ${this.watcher.host}:${this.watcher.port}: ${error.message}`);
    }
  }

  async stat(remotePath) {
    try {
      const actualPath = await this.resolveFtpPath(remotePath, async (candidate) => {
        const size = await this.client.size(candidate);
        return { size };
      });
      return actualPath.result;
    } catch (error) {
      wrapRemotePathNotFound(remotePath, error);
    }
  }

  async list(remoteDir) {
    const items = await this.client.list(remoteDir || '.');
    return items
      .filter((item) => item.isFile)
      .map((item) => ({ name: item.name, size: item.size, modifyTime: item.modifiedAt?.getTime() }));
  }

  async readRange(remotePath, start, endInclusive) {
    if (endInclusive < start) return Buffer.alloc(0);
    const chunks = [];
    const writable = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    });
    try {
      const actualPath = await this.resolveFtpPath(remotePath, async (candidate) => {
        await this.client.downloadTo(writable, candidate, start);
        return candidate;
      });
      return Buffer.concat(chunks).subarray(0, endInclusive - start + 1);
    } catch (error) {
      wrapRemotePathNotFound(remotePath, error);
    }
  }

  async resolveFtpPath(remotePath, operation) {
    try {
      return { result: await operation(remotePath), path: remotePath };
    } catch (error) {
      const withoutSlash = String(remotePath).replace(/^\/+/, '');
      if (error.code !== 550 || !withoutSlash || withoutSlash === remotePath) {
        throw error;
      }
      return { result: await operation(withoutSlash), path: withoutSlash };
    }
  }

  async close() {
    this.client.close();
  }
}

function createRemoteClient(watcher) {
  return watcher.protocol === 'ftp' ? new FtpRemoteClient(watcher) : new SftpRemoteClient(watcher);
}

function hasWildcard(remotePath) {
  return /[*?[\]]/.test(remotePath);
}

function wildcardToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|\\]/g, '\\$&');
  const regex = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regex}$`);
}

async function resolveRemotePath(client, remotePath) {
  if (!hasWildcard(remotePath)) {
    return remotePath;
  }

  const dir = path.dirname(remotePath);
  const pattern = path.basename(remotePath);
  const matcher = wildcardToRegex(pattern);
  const entries = await client.list(dir === '.' ? '' : dir);
  const matches = entries
    .filter((entry) => matcher.test(entry.name))
    .sort((a, b) => {
      if (a.name === b.name) return 0;
      return a.name < b.name ? 1 : -1;
    });

  if (matches.length === 0) {
    throw new RemotePathNotFoundError(remotePath);
  }

  return path.join(dir, matches[0].name);
}

async function testRemoteConnection(watcher) {
  const client = createRemoteClient(watcher);
  try {
    await client.connect();
    const resolvedPath = await resolveRemotePath(client, watcher.remotePath);
    const stat = await client.stat(resolvedPath);
    return { ok: true, size: stat.size, resolvedPath };
  } finally {
    await client.close();
  }
}

module.exports = {
  createRemoteClient,
  resolveRemotePath,
  testRemoteConnection,
  RemotePathNotFoundError,
  isRemotePathNotFoundError
};
