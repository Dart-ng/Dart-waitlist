const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const rateLimit = require('express-rate-limit').rateLimit;
const helmet = require('helmet');
const { AppDatabase } = require('./database');
const { OAuth2Client } = require('google-auth-library');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const port = Number(process.env.PORT || 3000);
const isVercel = process.env.VERCEL === '1';
const isVercelPreview = isVercel && process.env.VERCEL_ENV === 'preview';
const isProduction = process.env.NODE_ENV === 'production' && !isVercelPreview;
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const vercelBaseUrl = isVercel && process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
if (isProduction && !process.env.APP_BASE_URL) {
  throw new Error('APP_BASE_URL must be set to the public HTTPS URL in production.');
}
const appBaseUrl = (process.env.APP_BASE_URL || vercelBaseUrl || `http://localhost:${port}`).replace(/\/+$/, '');
const callbackUrl = process.env.GOOGLE_CALLBACK_URL || `${appBaseUrl}/auth/google/callback`;
const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const googleEnabled = Boolean(clientId && clientSecret && callbackUrl);
const appUrl = new URL(appBaseUrl);
const secureCookie = appUrl.protocol === 'https:';
const sessionCookieName = 'dart_session';
const sessionLifetimeSeconds = 60 * 60 * 24 * 30;
const databaseUrl = (process.env.DATABASE_URL || '').trim();
const databasePath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, 'data', 'dart.sqlite'));
const requiresPostgres = isProduction || (isVercel && process.env.VERCEL_ENV !== 'development');

if (requiresPostgres && !databaseUrl) {
  throw new Error('DATABASE_URL must point to the PostgreSQL database in production deployments.');
}

if (isProduction) {
  if (appUrl.protocol !== 'https:') {
    throw new Error('APP_BASE_URL must use HTTPS in production.');
  }
  if (!googleEnabled) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required in production.');
  }
  const callback = new URL(callbackUrl);
  if (callback.protocol !== 'https:' || callback.origin !== appUrl.origin || callback.pathname !== '/auth/google/callback') {
    throw new Error('GOOGLE_CALLBACK_URL must use the app HTTPS origin and /auth/google/callback path.');
  }
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port.');
}

if (process.env.TRUST_PROXY) {
  const trustProxyHops = Number(process.env.TRUST_PROXY);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 1) {
    throw new Error('TRUST_PROXY must be a positive number of trusted proxy hops.');
  }
  app.set('trust proxy', trustProxyHops);
}

const db = new AppDatabase({ databaseUrl, databasePath });
let databaseInitialization;

function ensureDatabase() {
  if (!databaseInitialization) {
    databaseInitialization = db.initialize().catch((error) => {
      databaseInitialization = null;
      throw error;
    });
  }
  return databaseInitialization;
}

const googleClient = googleEnabled
  ? new OAuth2Client(clientId, clientSecret, callbackUrl)
  : null;

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https://googleusercontent.com', 'https://*.googleusercontent.com'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
}));
app.use(express.json({ limit: '16kb' }));
app.use(async (req, res, next) => {
  try {
    await ensureDatabase();
    next();
  } catch (error) {
    next(error);
  }
});
app.use('/assets', express.static(path.join(__dirname, 'assets'), {
  dotfiles: 'deny',
  fallthrough: false,
  index: false,
  maxAge: '1d',
}));

const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please try again later.' },
});

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}


const NICKNAME_ADJECTIVES = ['Reaper', 'Skipper', 'Archer', 'Gunner', 'Falcon', 'Viper', 'Shadow', 'Blaze', 'Cosmo', 'Titan', 'Ghost', 'Nova'];
function generateNickname(name, email, id) {
  const seed = (String(name || '') + String(email || '') + String(id || '')).split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const adj = NICKNAME_ADJECTIVES[seed % NICKNAME_ADJECTIVES.length];
  const num = (seed % 89) + 10;
  return `${adj}${num}`;
}

function getFirstName(value) {
  return typeof value === 'string' ? value.trim().split(/\s+/)[0] || '' : '';
}

function getCookie(req, name) {
  const cookies = (req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    }
  }
  return null;
}

function setSessionCookie(res, token) {
  const secure = secureCookie ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionLifetimeSeconds}${secure}`,
  );
}

function clearSessionCookie(res) {
  const secure = secureCookie ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
}

async function getSessionUser(req) {
  const token = getCookie(req, sessionCookieName);
  if (!token) return null;
  const session = await db.get(`
    SELECT users.id, users.name, users.email, users.queue_number,
           users.referral_code, users.referral_count, users.created_at,
           users.google_picture_url
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `, [hash(token), Math.floor(Date.now() / 1000)]);
  return session || null;
}

async function requireAuth(req, res, next) {
  const user = await getSessionUser(req);
  if (!user) {
    if (req.path === '/waitlist' || req.path === '/waitlist.html') {
      return res.redirect('/signup.html');
    }
    return res.status(401).json({ error: 'Please sign in to continue.' });
  }
  req.user = user;
  next();
}

function getGooglePictureUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      (url.hostname === 'googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com'))
    ) {
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

async function createOrFindUser({ googleSub, email, name, pictureUrl, referralCode }) {
  if (!db.isPostgres) {
    const sqlite = db.sqlite;
    return db.sqliteTransaction(() => {
      const userByGoogle = sqlite.prepare('SELECT * FROM users WHERE google_sub = ?').get(googleSub);
      const userByEmail = sqlite.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);

      if (userByGoogle) {
        if (userByEmail && userByEmail.id !== userByGoogle.id) {
          throw new Error('That Google account email is already linked to another waitlist account.');
        }
        sqlite.prepare('UPDATE users SET email = ?, name = ?, google_picture_url = COALESCE(?, google_picture_url) WHERE id = ?')
          .run(email, name || userByGoogle.name, pictureUrl, userByGoogle.id);
        return sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userByGoogle.id);
      }

      if (userByEmail) {
        if (userByEmail.google_sub) {
          throw new Error('This email is already linked to a different Google account.');
        }
        sqlite.prepare('UPDATE users SET google_sub = ?, google_picture_url = COALESCE(?, google_picture_url) WHERE id = ?')
          .run(googleSub, pictureUrl, userByEmail.id);
        return sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userByEmail.id);
      }

      const referrer = referralCode
        ? sqlite.prepare('SELECT id FROM users WHERE referral_code = ? COLLATE NOCASE').get(referralCode)
        : null;
      const queueNumber = sqlite.prepare('SELECT COALESCE(MAX(queue_number), 0) + 1 AS next FROM users').get().next;
      let newReferralCode;
      do {
        newReferralCode = crypto.randomBytes(8).toString('hex').toUpperCase();
      } while (sqlite.prepare('SELECT 1 FROM users WHERE referral_code = ?').get(newReferralCode));

      const result = sqlite.prepare(`
        INSERT INTO users (name, email, interest, queue_number, referral_code, referred_by, google_sub, google_picture_url, created_at)
        VALUES (?, ?, 'unspecified', ?, ?, ?, ?, ?, ?)
      `).run(
        name || email.split('@')[0],
        email,
        queueNumber,
        newReferralCode,
        referrer ? referrer.id : null,
        googleSub,
        pictureUrl,
        new Date().toISOString(),
      );

      if (referrer) {
        sqlite.prepare('UPDATE users SET referral_count = referral_count + 1 WHERE id = ?').run(referrer.id);
      }
      return sqlite.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    });
  }

  return db.transaction(async (client) => {
    const userByGoogle = await db.get('SELECT * FROM users WHERE google_sub = ?', [googleSub], client);
    const userByEmail = await db.get('SELECT * FROM users WHERE lower(email) = lower(?)', [email], client);

    if (userByGoogle) {
      if (userByEmail && userByEmail.id !== userByGoogle.id) {
        throw new Error('That Google account email is already linked to another waitlist account.');
      }
      await db.run(
        'UPDATE users SET email = ?, name = ?, google_picture_url = COALESCE(?, google_picture_url) WHERE id = ?',
        [email, name || userByGoogle.name, pictureUrl, userByGoogle.id],
        client,
      );
      return db.get('SELECT * FROM users WHERE id = ?', [userByGoogle.id], client);
    }

    if (userByEmail) {
      if (userByEmail.google_sub) {
        throw new Error('This email is already linked to a different Google account.');
      }
      await db.run(
        'UPDATE users SET google_sub = ?, google_picture_url = COALESCE(?, google_picture_url) WHERE id = ?',
        [googleSub, pictureUrl, userByEmail.id],
        client,
      );
      return db.get('SELECT * FROM users WHERE id = ?', [userByEmail.id], client);
    }

    const referrer = referralCode
      ? await db.get('SELECT id FROM users WHERE lower(referral_code) = lower(?)', [referralCode], client)
      : null;
    const queueNumber = await db.nextQueueNumber(client);
    let newReferralCode;
    do {
      newReferralCode = crypto.randomBytes(8).toString('hex').toUpperCase();
    } while (await db.get('SELECT 1 FROM users WHERE referral_code = ?', [newReferralCode], client));

    const inserted = await db.get(`
      INSERT INTO users (name, email, interest, queue_number, referral_code, referred_by, google_sub, google_picture_url, created_at)
      VALUES (?, ?, 'unspecified', ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [
      name || email.split('@')[0],
      email,
      queueNumber,
      newReferralCode,
      referrer ? referrer.id : null,
      googleSub,
      pictureUrl,
      new Date().toISOString(),
    ], client);

    if (referrer) {
      await db.run('UPDATE users SET referral_count = referral_count + 1 WHERE id = ?', [referrer.id], client);
    }
    return db.get('SELECT * FROM users WHERE id = ?', [inserted.id], client);
  });
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Math.floor(Date.now() / 1000) + sessionLifetimeSeconds;
  await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [
    hash(token),
    userId,
    expiresAt,
  ]);
  return token;
}

async function getPublicStats() {
  const totalResult = await db.get('SELECT COUNT(*) AS total FROM users');
  const avatars = await db.all(`
    SELECT google_picture_url AS "pictureUrl"
    FROM users
    WHERE google_picture_url IS NOT NULL
    ORDER BY id DESC
    LIMIT 5
  `);
  return { total: Number(totalResult.total), avatars: avatars.map((user) => user.pictureUrl) };
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/signup.html', (req, res) => res.sendFile(path.join(__dirname, 'signup.html')));
app.get('/about.html', (req, res) => res.sendFile(path.join(__dirname, 'about.html')));
app.get('/logistics.html', (req, res) => res.sendFile(path.join(__dirname, 'logistics.html')));
function sendWaitlistPage(req, res) {
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(path.join(__dirname, 'waitlist.html'));
}
app.get('/waitlist', requireAuth, sendWaitlistPage);
app.get('/waitlist.html', requireAuth, sendWaitlistPage);
app.get('/healthz', async (req, res) => {
  await db.get('SELECT 1');
  res.set('Cache-Control', 'no-store').json({ status: 'ok' });
});

app.get('/api/config', (req, res) => {
  res.json({ googleEnabled });
});

app.get('/api/stats', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await getPublicStats());
});

app.get('/api/me', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const stats = await getPublicStats();
  const total = stats.total;
  const aheadResult = await db.get('SELECT COUNT(*) AS count FROM users WHERE queue_number < ?', [req.user.queue_number]);
  const leaders = await db.all(`
    SELECT id, name, referral_count AS "referralCount", google_picture_url AS "pictureUrl"
    FROM users
    WHERE referral_count > 0
    ORDER BY referral_count DESC, queue_number ASC
    LIMIT 4
  `);
  const formattedLeaders = leaders.map((leader) => ({
    name: leader.id === req.user.id ? 'You' : getFirstName(leader.name),
    referralCount: leader.referralCount,
    pictureUrl: leader.pictureUrl,
  }));

  // Fetch all registered participants on the platform
  const participantRows = await db.all(`
    SELECT id, name, email, queue_number AS "queueNumber", referral_count AS "referralCount", google_picture_url AS "pictureUrl"
    FROM users
    ORDER BY queue_number ASC
  `);
  const participants = participantRows.map((p) => ({
    id: p.id,
    name: p.name || 'Anonymous',
    nickname: generateNickname(p.name, p.email, p.id),
    queueNumber: p.queueNumber,
    referralCount: p.referralCount || 0,
    pictureUrl: p.pictureUrl,
    isSelf: p.id === req.user.id,
  }));

  res.json({
    name: getFirstName(req.user.name),
    fullName: req.user.name || '',
    nickname: generateNickname(req.user.name, req.user.email, req.user.id),
    email: req.user.email,
    queueNumber: req.user.queue_number,
    total,
    avatars: stats.avatars,
    ahead: Number(aheadResult.count),
    referralCount: req.user.referral_count,
    pictureUrl: req.user.google_picture_url,
    leaders: formattedLeaders,
    participants,
    referralUrl: `${appBaseUrl}/signup.html?ref=${encodeURIComponent(req.user.referral_code)}`,
    registeredAt: req.user.created_at,
  });
});

app.post('/api/login', authRateLimit, (req, res) => {
  res.status(501).json({ error: 'Email and password sign-in is not enabled yet. Continue with Google instead.' });
});

app.post('/api/logout', requireAuth, async (req, res) => {
  const token = getCookie(req, sessionCookieName);
  await db.run('DELETE FROM sessions WHERE token_hash = ?', [hash(token)]);
  clearSessionCookie(res);
  res.json({ signedOut: true });
});

app.get('/auth/google', authRateLimit, async (req, res) => {
  if (!googleClient) {
    return res.status(503).send('Google sign-in is not configured on this server.');
  }

  const rawReferralCode = typeof req.query.ref === 'string' ? req.query.ref.trim() : '';
  if (rawReferralCode.length > 64) {
    return res.status(400).send('Invalid referral link.');
  }
  const referrer = rawReferralCode
    ? await db.get('SELECT referral_code FROM users WHERE lower(referral_code) = lower(?)', [rawReferralCode])
    : null;
  if (rawReferralCode && !referrer) {
    return res.status(400).send('This referral link is not valid.');
  }

  const now = Math.floor(Date.now() / 1000);
  await db.run('DELETE FROM oauth_states WHERE expires_at <= ?', [now]);
  const state = crypto.randomBytes(32).toString('base64url');
  await db.run('INSERT INTO oauth_states (state_hash, referral_code, expires_at) VALUES (?, ?, ?)', [
    hash(state),
    referrer ? referrer.referral_code : null,
    now + 10 * 60,
  ]);
  const authorizationUrl = googleClient.generateAuthUrl({
    access_type: 'online',
    prompt: 'select_account',
    scope: ['openid', 'email', 'profile'],
    state,
  });
  res.redirect(authorizationUrl);
});

app.get('/auth/google/callback', authRateLimit, async (req, res) => {
  if (!googleClient || typeof req.query.state !== 'string') {
    return res.redirect('/signup.html?oauthError=failed');
  }

  const stateHash = hash(req.query.state);
  const now = Math.floor(Date.now() / 1000);
  const stateRow = await db.get('SELECT referral_code, expires_at FROM oauth_states WHERE state_hash = ?', [stateHash]);
  await db.run('DELETE FROM oauth_states WHERE state_hash = ?', [stateHash]);
  if (!stateRow || stateRow.expires_at <= now) {
    return res.redirect('/signup.html?oauthError=failed');
  }
  if (req.query.error) {
    return res.redirect('/signup.html?oauthError=cancelled');
  }
  if (typeof req.query.code !== 'string') {
    return res.redirect('/signup.html?oauthError=failed');
  }

  try {
    const { tokens } = await googleClient.getToken({
      code: req.query.code,
      redirect_uri: callbackUrl,
    });
    if (!tokens.id_token) {
      throw new Error('Google did not return an ID token.');
    }
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: clientId,
    });
    const profile = ticket.getPayload();
    if (!profile || !profile.sub || !profile.email || profile.email_verified !== true) {
      throw new Error('Google account email is not verified.');
    }

    const user = await createOrFindUser({
      googleSub: profile.sub,
      email: profile.email.trim().toLowerCase(),
      name: typeof profile.name === 'string' ? profile.name.trim().slice(0, 200) : '',
      pictureUrl: getGooglePictureUrl(profile.picture),
      referralCode: stateRow.referral_code,
    });
    const sessionToken = await createSession(user.id);
    setSessionCookie(res, sessionToken);
    res.redirect('/waitlist');
  } catch (error) {
    console.error('Google sign-in failed:', error.name || 'Error');
    res.redirect('/signup.html?oauthError=failed');
  }
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('Request failed:', JSON.stringify({
    method: req.method,
    path: req.path,
    name: err.name || 'Error',
    code: typeof err.code === 'string' ? err.code : 'unknown',
    syscall: typeof err.syscall === 'string' ? err.syscall : undefined,
    address: typeof err.address === 'string' ? err.address : undefined,
    port: Number.isInteger(err.port) ? err.port : undefined,
  }));
  res.status(err.status || 500).json({ error: 'The request could not be completed.' });
});

let server;
async function startServer() {
  await ensureDatabase();
  server = app.listen(port, host, () => {
    console.log(`DART waitlist server listening at ${appBaseUrl}`);
    if (!googleEnabled) {
      console.warn('Google sign-in is disabled: configure the OAuth variables in .env.');
    }
  });
}

module.exports = app;

if (!isVercel) {
  let shutdownStarted = false;
  function shutdown(signal) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log(`Received ${signal}; shutting down.`);
    if (!server) {
      db.close().catch((error) => {
        console.error('Database shutdown failed:', error.name || 'Error');
        process.exitCode = 1;
      });
      return;
    }
    server.close((error) => {
      if (error) {
        console.error('HTTP server shutdown failed:', error.name || 'Error');
        process.exitCode = 1;
      }
      db.close().catch((closeError) => {
        console.error('Database shutdown failed:', closeError.name || 'Error');
        process.exitCode = 1;
      });
    });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  startServer().catch((error) => {
    console.error('Server startup failed:', error.name || 'Error');
    process.exitCode = 1;
    db.close().catch((closeError) => {
      console.error('Database shutdown failed:', closeError.name || 'Error');
      process.exitCode = 1;
    });
  });
}
