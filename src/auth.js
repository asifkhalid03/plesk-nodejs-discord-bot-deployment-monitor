const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const sessions = new Map();
const cookieName = 'dlw_session';
const envPath = path.join(__dirname, '..', '.env');

function parseCookies(req) {
  return String(req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf('=');
      if (index === -1) return cookies;
      cookies[decodeURIComponent(part.slice(0, index))] = decodeURIComponent(part.slice(index + 1));
      return cookies;
    }, {});
}

function normalizeIp(ip) {
  return String(ip || '')
    .replace(/^::ffff:/, '')
    .replace(/^::1$/, '127.0.0.1');
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return normalizeIp(forwarded || req.ip || req.socket.remoteAddress);
}

function isLocalRequest(req) {
  return ['127.0.0.1', 'localhost'].includes(getClientIp(req));
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sign(value) {
  const secret = config.uiSessionSecret || 'local-dev-session-secret';
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createCookie(sessionId) {
  const value = `${sessionId}.${sign(sessionId)}`;
  return `${cookieName}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`;
}

function clearCookie() {
  return `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function readSession(req) {
  const value = parseCookies(req)[cookieName];
  if (!value) return null;
  const [sessionId, signature] = value.split('.');
  if (!sessionId || !signature || !safeEqual(signature, sign(sessionId))) return null;
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function wantsJson(req) {
  return req.path.startsWith('/api/') || String(req.headers.accept || '').includes('application/json');
}

function isLoginConfigured() {
  return Boolean(config.uiLoginEmail && config.uiLoginPassword);
}

function isSetupComplete() {
  return Boolean(config.encryptionKey && config.uiLoginEmail && config.uiLoginPassword && config.uiSessionSecret);
}

function formatEnvValue(value) {
  const text = String(value || '');
  if (!text || /[\s#"'\\]/.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}

function upsertEnvValues(values) {
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const seen = new Set();
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match || !Object.prototype.hasOwnProperty.call(values, match[1])) return line;
    seen.add(match[1]);
    return `${match[1]}=${formatEnvValue(values[match[1]])}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) nextLines.push(`${key}=${formatEnvValue(value)}`);
  }

  fs.writeFileSync(envPath, nextLines.join('\n').replace(/\n*$/, '\n'));
  Object.assign(process.env, values);
  Object.assign(config, {
    encryptionKey: values.ENCRYPTION_KEY || config.encryptionKey,
    discordBotToken: values.DISCORD_BOT_TOKEN || config.discordBotToken,
    discordClientId: values.DISCORD_CLIENT_ID || config.discordClientId,
    discordGuildId: values.DISCORD_GUILD_ID || config.discordGuildId,
    dailyReportsChannelId: values.DAILY_REPORTS_CHANNEL_ID || config.dailyReportsChannelId,
    reportsDownloadChannelId: values.REPORTS_DOWNLOAD_CHANNEL_ID || config.reportsDownloadChannelId,
    uiLoginEmail: values.UI_LOGIN_EMAIL || config.uiLoginEmail,
    uiLoginPassword: values.UI_LOGIN_PASSWORD || config.uiLoginPassword,
    uiSessionSecret: values.UI_SESSION_SECRET || config.uiSessionSecret
  });
}

function registerAuth(app) {
  if (config.trustProxy) app.set('trust proxy', true);

  app.use((req, res, next) => {
    if (!config.ipRestrict) return next();
    const clientIp = getClientIp(req);
    const allowed = config.ipAllowlist.map(normalizeIp);
    if (allowed.includes(clientIp)) return next();
    return res.status(403).send(`Access denied for IP ${clientIp}`);
  });

  app.get('/login', (req, res) => {
    if (!isSetupComplete()) return res.redirect('/setup');
    if (!isLoginConfigured()) return res.redirect('/');
    if (readSession(req)) return res.redirect('/');
    return res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
  });

  app.get('/setup', (req, res) => {
    if (isSetupComplete()) return res.redirect('/login');
    return res.sendFile(path.join(__dirname, '..', 'public', 'setup.html'));
  });

  app.get('/api/setup/status', (req, res) => {
    return res.json({
      setupComplete: isSetupComplete(),
      hasEncryptionKey: Boolean(config.encryptionKey),
      hasUiLogin: isLoginConfigured(),
      hasSessionSecret: Boolean(config.uiSessionSecret),
      discordConfigured: Boolean(config.discordBotToken)
    });
  });

  app.post('/api/setup', (req, res) => {
    if (isSetupComplete()) return res.status(409).json({ error: 'Setup is already complete.' });

    const email = String(req.body?.uiLoginEmail || '').trim();
    const password = String(req.body?.uiLoginPassword || '');
    const confirmPassword = String(req.body?.confirmPassword || '');
    const encryptionKey = String(req.body?.encryptionKey || '').trim();
    const uiSessionSecret = String(req.body?.uiSessionSecret || '').trim();
    const discordToken = String(req.body?.discordBotToken || '').trim();
    const discordGuildId = String(req.body?.discordGuildId || '').trim();
    const discordClientId = String(req.body?.discordClientId || '').trim();
    const dailyReportsChannelId = String(req.body?.dailyReportsChannelId || '').trim();
    const reportsDownloadChannelId = String(req.body?.reportsDownloadChannelId || '').trim();

    if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid login email is required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match.' });
    if (encryptionKey && Buffer.byteLength(encryptionKey) < 32) {
      return res.status(400).json({ error: 'Encryption key must be at least 32 bytes, or leave it blank to generate one.' });
    }
    if (uiSessionSecret && Buffer.byteLength(uiSessionSecret) < 32) {
      return res.status(400).json({ error: 'Session secret must be at least 32 bytes, or leave it blank to generate one.' });
    }

    const values = {
      ENCRYPTION_KEY: encryptionKey || config.encryptionKey || crypto.randomBytes(32).toString('base64'),
      UI_LOGIN_EMAIL: email,
      UI_LOGIN_PASSWORD: password,
      UI_SESSION_SECRET: uiSessionSecret || config.uiSessionSecret || crypto.randomBytes(32).toString('base64')
    };

    if (discordToken) values.DISCORD_BOT_TOKEN = discordToken;
    if (discordGuildId) values.DISCORD_GUILD_ID = discordGuildId;
    if (discordClientId) values.DISCORD_CLIENT_ID = discordClientId;
    if (dailyReportsChannelId) values.DAILY_REPORTS_CHANNEL_ID = dailyReportsChannelId;
    if (reportsDownloadChannelId) values.REPORTS_DOWNLOAD_CHANNEL_ID = reportsDownloadChannelId;

    upsertEnvValues(values);
    return res.json({ ok: true });
  });

  app.post('/api/auth/login', (req, res) => {
    if (!isSetupComplete()) return res.status(428).json({ error: 'First-time setup is required.' });
    if (!isLoginConfigured()) {
      return res.json({ ok: true, authenticated: false });
    }

    const email = String(req.body?.email || '');
    const password = String(req.body?.password || '');
    if (!safeEqual(email, config.uiLoginEmail) || !safeEqual(password, config.uiLoginPassword)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const sessionId = crypto.randomBytes(32).toString('base64url');
    sessions.set(sessionId, {
      email,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000
    });

    res.setHeader('Set-Cookie', createCookie(sessionId));
    return res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    const value = parseCookies(req)[cookieName];
    const sessionId = value?.split('.')[0];
    if (sessionId) sessions.delete(sessionId);
    res.setHeader('Set-Cookie', clearCookie());
    return res.json({ ok: true });
  });

  app.get('/api/auth/status', (req, res) => {
    if (!isSetupComplete()) {
      return res.json({ setupComplete: false, authConfigured: false, authenticated: false, email: null });
    }

    if (!isLoginConfigured()) {
      return res.json({ setupComplete: true, authConfigured: false, authenticated: false, email: null });
    }

    const session = readSession(req);
    return res.json({ setupComplete: true, authConfigured: true, authenticated: Boolean(session), email: session?.email || null });
  });

  app.get('/api/auth/debug', (req, res) => {
    if (!isLocalRequest(req)) return res.status(404).json({ error: 'Not found.' });
    return res.json({
      authConfigured: isLoginConfigured(),
      configuredEmail: config.uiLoginEmail || null,
      passwordLength: config.uiLoginPassword.length,
      sessionSecretSet: Boolean(config.uiSessionSecret)
    });
  });

  app.use((req, res, next) => {
    if (!isSetupComplete()) {
      if (
        req.path === '/setup.html' ||
        req.path === '/styles.css' ||
        req.path === '/favicon.ico' ||
        req.path.startsWith('/api/setup')
      ) {
        return next();
      }
      if (wantsJson(req)) return res.status(428).json({ error: 'First-time setup is required.' });
      return res.redirect('/setup');
    }

    if (!isLoginConfigured()) return next();
    if (
      req.path === '/login.html' ||
      req.path === '/setup.html' ||
      req.path === '/styles.css' ||
      req.path === '/app.js' ||
      req.path === '/favicon.ico' ||
      req.path.startsWith('/hooks/')
    ) {
      return next();
    }
    if (readSession(req)) return next();
    if (wantsJson(req)) return res.status(401).json({ error: 'Login required.' });
    return res.redirect('/login');
  });
}

module.exports = registerAuth;
