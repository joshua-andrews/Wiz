'use strict';
/*
  Basic Strategy Flashcards + Bets of the Day: a tiny web server that puts a login in front of
  index.html (blackjack drills) and bets.html (today's most popular bets, from bets.js).
  No dependencies, only Node's built-in modules.

  Settings (Railway → service → Variables):
    USERS           Logins, comma-separated: "player:secret-one,sam:secret-two"
                    (a password can contain anything except a comma)
    SESSION_SECRET  A long random string used to sign login cookies
    PORT            Set by Railway automatically
*/
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const bets = require('./bets.js');

const PORT = Number(process.env.PORT) || 3000;
const COOKIE = 'bsf_session';
const SESSION_DAYS = 90;
const MAX_FAILS = 10;               // failed sign-ins allowed per address...
const FAIL_WINDOW_MS = 15 * 60e3;   // ...in this window

// ---- Users and sessions -------------------------------------------------
const USERS = new Map();
for (const entry of (process.env.USERS || '').split(',')) {
  const i = entry.indexOf(':');
  if (i < 1) continue;
  const name = entry.slice(0, i).trim().toLowerCase();
  const pass = entry.slice(i + 1).trim();
  if (name && pass) USERS.set(name, pass);
}
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const sameText = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
// Changing a user's password (or removing them) signs them out everywhere.
const passwordTag = name => sign(`pw:${name}:${USERS.get(name)}`).slice(0, 12);

function makeToken(name) {
  const body = `${Buffer.from(name).toString('base64url')}.${Date.now() + SESSION_DAYS * 864e5}`;
  return `${body}.${sign(`${body}.${passwordTag(name)}`)}`;
}
function readToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [n64, exp, sig] = parts;
  const name = Buffer.from(n64, 'base64url').toString();
  if (!USERS.has(name) || !(Number(exp) > Date.now())) return null;
  return sameText(sig, sign(`${n64}.${exp}.${passwordTag(name)}`)) ? name : null;
}
function checkPassword(name, pass) {
  const stored = USERS.get(name);
  // Compare signatures so the check takes the same time whatever the input.
  const ok = sameText(sign(`c:${pass}`), sign(`c:${stored === undefined ? crypto.randomUUID() : stored}`));
  return stored !== undefined && ok;
}

// ---- Slow down password guessing ------------------------------------------
const fails = new Map();
const clientIp = req => String(req.headers['x-real-ip'] || '').trim()
  || String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()
  || req.socket.remoteAddress || 'unknown';
function isBlocked(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() > f.reset) { fails.delete(ip); return false; }
  return f.count >= MAX_FAILS;
}
function noteFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() > f.reset) fails.set(ip, { count: 1, reset: Date.now() + FAIL_WINDOW_MS });
  else f.count++;
}
setInterval(() => { const now = Date.now(); for (const [ip, f] of fails) if (now > f.reset) fails.delete(ip); }, 60e3).unref();

// ---- Files ------------------------------------------------------------------
const file = f => fs.readFileSync(path.join(__dirname, f));
const APP_HTML = file('index.html').toString('utf8');
const LOGIN_HTML = file('login.html').toString('utf8');
const BETS_HTML = file('bets.html').toString('utf8');
const PUBLIC = {
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icons/favicon.svg': ['icons/favicon.svg', 'image/svg+xml'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png'],
  '/icons/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png'],
  '/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png'],
  '/favicon.ico': ['icons/icon-192.png', 'image/png'],
};
for (const k of Object.keys(PUBLIC)) PUBLIC[k] = [file(PUBLIC[k][0]), PUBLIC[k][1]];

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const loginPage = (error, username) => LOGIN_HTML
  .replace('{{error}}', error ? `<p class="err" role="alert">${esc(error)}</p>` : '')
  .replace('{{username}}', esc(username || ''));
const appPage = name => APP_HTML.replace('<!--account-->',
  `<div class="panel"><h2>Bets of the Day</h2><p class="lede">Today's most popular bets at DraftKings, with % of bets and % of money.</p>`
  + `<div class="reset-row"><a class="btn" href="/bets" style="text-decoration:none;color:inherit">Open the bets board &rarr;</a></div></div>`
  + `<div class="panel"><h2>Account</h2><p class="lede">Signed in as <b>${esc(name)}</b>.</p>`
  + `<form method="post" action="/logout" class="reset-row"><button type="submit" class="btn">Log out</button></form></div>`);
const betsPage = name => BETS_HTML.replace('<!--account-->',
  `<div class="acct"><span>Signed in as <b>${esc(name)}</b></span>`
  + `<form method="post" action="/logout"><button type="submit" class="btn">Log out</button></form></div>`);

// ---- HTTP helpers -------------------------------------------------------------
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "manifest-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

function send(req, res, status, body, type, extra = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': CSP,
    ...(req.secure ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    ...extra,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}
function sendJson(req, res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && body.length > 1024) {
    return send(req, res, status, zlib.gzipSync(body), 'application/json; charset=utf-8', { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
  }
  return send(req, res, status, body, 'application/json; charset=utf-8');
}
const redirect = (req, res, to, extra = {}) => send(req, res, 303, '', 'text/plain; charset=utf-8', { Location: to, ...extra });
const html = 'text/html; charset=utf-8';

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}
const sessionCookie = (req, value, maxAge) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;

function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 8192) { reject(new Error('Form too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}
const pause = ms => new Promise(r => setTimeout(r, ms));

// ---- Routes ---------------------------------------------------------------------
async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (isBlocked(ip)) return send(req, res, 429, loginPage('Too many tries. Wait 15 minutes, then try again.', ''), html);
  const form = await readForm(req);
  const name = String(form.get('username') || '').trim().toLowerCase();
  const pass = String(form.get('password') || '');
  if (!USERS.size) return send(req, res, 503, loginPage('No logins are set up yet. Add USERS in the Railway variables.', name), html);
  if (!checkPassword(name, pass)) {
    noteFail(ip);
    await pause(600);
    return send(req, res, 401, loginPage("That username and password don't match.", name), html);
  }
  fails.delete(ip);
  return redirect(req, res, '/', { 'Set-Cookie': sessionCookie(req, makeToken(name), SESSION_DAYS * 86400) });
}

const server = http.createServer(async (req, res) => {
  try {
    req.secure = req.headers['x-forwarded-proto'] === 'https';
    const { pathname } = new URL(req.url, 'http://local');
    const reading = req.method === 'GET' || req.method === 'HEAD';

    if (pathname === '/healthz') return send(req, res, 200, 'ok', 'text/plain; charset=utf-8');
    if (PUBLIC[pathname] && reading) {
      const [body, type] = PUBLIC[pathname];
      return send(req, res, 200, body, type, { 'Cache-Control': 'public, max-age=86400' });
    }

    const user = readToken(cookieValue(req, COOKIE));
    if (pathname === '/login') {
      if (req.method === 'POST') return await handleLogin(req, res);
      if (user) return redirect(req, res, '/');
      return send(req, res, 200, loginPage('', ''), html);
    }
    if (pathname === '/logout') return redirect(req, res, '/login', { 'Set-Cookie': sessionCookie(req, '', 0) });
    if (pathname === '/api/bets' && reading) {
      if (!user) return sendJson(req, res, 401, { error: 'Signed out' });
      try {
        const force = new URL(req.url, 'http://local').searchParams.get('fresh') === '1';
        return sendJson(req, res, 200, await bets.getBoard({ force }));
      } catch (err) {
        console.error('Bets board failed:', err.message);
        return sendJson(req, res, 502, { error: "Couldn't reach DraftKings right now" });
      }
    }
    if (!user) return redirect(req, res, '/login');
    if ((pathname === '/' || pathname === '/index.html') && reading) return send(req, res, 200, appPage(user), html);
    if (pathname === '/bets' && reading) return send(req, res, 200, betsPage(user), html);
    return send(req, res, 404, 'Not found', 'text/plain; charset=utf-8');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(req, res, 500, 'Something went wrong. Try again.', 'text/plain; charset=utf-8');
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Basic Strategy Flashcards listening on port ${PORT} with ${USERS.size} login(s).`);
  if (!USERS.size) console.warn('No USERS set: nobody can sign in until you add USERS="name:password".');
  if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET not set: everyone is signed out whenever the server restarts.');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
