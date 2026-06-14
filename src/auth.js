const crypto = require('crypto');
const path = require('path');
const config = require('./config');

const sessions = new Map();
const cookieName = 'dlw_session';

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
    if (!isLoginConfigured()) return res.redirect('/');
    if (readSession(req)) return res.redirect('/');
    return res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
  });

  app.post('/api/auth/login', (req, res) => {
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
    if (!isLoginConfigured()) {
      return res.json({ authConfigured: false, authenticated: false, email: null });
    }

    const session = readSession(req);
    return res.json({ authConfigured: true, authenticated: Boolean(session), email: session?.email || null });
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
    if (!isLoginConfigured()) return next();
    if (
      req.path === '/login.html' ||
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
