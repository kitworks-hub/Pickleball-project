/* Shared server code for the MPC API (Vercel Node functions). Storage is Supabase (see below); no npm packages are needed. */
'use strict';
const crypto = require('crypto');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
const TZ = process.env.APP_TIMEZONE || 'Asia/Manila';
const PW_ITER = 200000;
const TOKEN_DAYS = 30;

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

/* ---------- storage ----------
   Supabase (Postgres) through its REST API, using the server-only service key. One table, public.docs(col, id, data),
   holds every document; public.counters backs the change counter and the login rate limits (see supabase/setup.sql).
   The page's code talks to it with a few Redis-style commands (HGET, HSET, HSETNX, HDEL, HGETALL) kept from the first version.
   With no Supabase variables set and NODE_ENV not "production", an in-memory store is used so the site can be tried locally. */
const mem = { docs: {}, counters: {} };
const memCol = c => (mem.docs[c] = mem.docs[c] || {});
function memRun(cmd) {
  const op = cmd[0], col = String(cmd[1]).replace(/^mpc:c:/, '');
  switch (op) {
    case 'HGET': return memCol(col)[cmd[2]] ?? null;
    case 'HSET': memCol(col)[cmd[2]] = cmd[3]; return 1;
    case 'HSETNX': if (cmd[2] in memCol(col)) return 0; memCol(col)[cmd[2]] = cmd[3]; return 1;
    case 'HDEL': { const had = cmd[2] in memCol(col); delete memCol(col)[cmd[2]]; return had ? 1 : 0; }
    case 'HGETALL': { const o = memCol(col), a = []; Object.keys(o).forEach(f => a.push(f, o[f])); return a; }
    default: throw new Error('memory store: unsupported ' + op);
  }
}
async function sb(method, pathAndQuery, body, prefer) {
  // New-style keys (sb_secret_...) go in the apikey header only; old-style service_role keys are JWTs and are also sent as Bearer.
  const headers = { apikey: SB_KEY, 'Content-Type': 'application/json' };
  if (SB_KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + SB_KEY;
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(SB_URL + '/rest/v1/' + pathAndQuery, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw httpErr(502, 'The database did not accept that (' + r.status + ').');
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}
const q = v => encodeURIComponent(v);
async function sbRun(cmd) {
  const op = cmd[0], col = String(cmd[1]).replace(/^mpc:c:/, '');
  switch (op) {
    case 'HGET': {
      const rows = await sb('GET', 'docs?select=data&col=eq.' + q(col) + '&id=eq.' + q(cmd[2]));
      return rows.length ? JSON.stringify(rows[0].data) : null;
    }
    case 'HGETALL': {
      const rows = await sb('GET', 'docs?select=id,data&col=eq.' + q(col));
      const flat = []; rows.forEach(r => flat.push(r.id, JSON.stringify(r.data)));
      return flat;
    }
    case 'HSET':
      await sb('POST', 'docs?on_conflict=col,id', { col, id: cmd[2], data: JSON.parse(cmd[3]) }, 'resolution=merge-duplicates,return=minimal');
      return 1;
    case 'HSETNX': {   // inserts only when absent; the row comes back only if it was inserted
      const rows = await sb('POST', 'docs?on_conflict=col,id', { col, id: cmd[2], data: JSON.parse(cmd[3]) }, 'resolution=ignore-duplicates,return=representation');
      return rows && rows.length ? 1 : 0;
    }
    case 'HDEL':
      await sb('DELETE', 'docs?col=eq.' + q(col) + '&id=eq.' + q(cmd[2]), undefined, 'return=minimal');
      return 1;
    default: throw new Error('unsupported ' + op);
  }
}
const configured = () => !!(SB_URL && SB_KEY);
async function redis(cmds) {
  if (!configured()) {
    if (IS_PROD) throw httpErr(500, 'The database is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    return cmds.map(memRun);
  }
  return Promise.all(cmds.map(sbRun));
}
const one = async cmd => (await redis([cmd]))[0];
const K = col => 'mpc:c:' + col;
const COLS = ['sessions', 'signups', 'members', 'roles', 'bookings', 'config', 'logins'];
const parse = s => { if (s == null) return null; try { return JSON.parse(s); } catch (e) { return null; } };
const getDoc = async (col, id) => parse(await one(['HGET', K(col), id]));

// A counter that goes up on every write, so the page can ask "has anything changed?" cheaply.
async function bump() {
  if (!configured()) { mem.counters.rev = (mem.counters.rev || 0) + 1; return; }
  await sb('POST', 'rpc/mpc_incr', { k: 'rev' });
}
async function getRev() {
  if (!configured()) return mem.counters.rev || 0;
  const rows = await sb('GET', 'counters?select=n&key=eq.rev');
  return rows.length ? Number(rows[0].n) : 0;
}
// Counts tries in a time window (login rate limits). Returns how many there have been, including this one.
async function hit(key, seconds) {
  if (!configured()) {
    const c = mem.counters['h:' + key];
    if (!c || c.until < Date.now()) { mem.counters['h:' + key] = { n: 1, until: Date.now() + seconds * 1000 }; return 1; }
    return ++c.n;
  }
  return Number(await sb('POST', 'rpc/mpc_hit', { k: key, secs: seconds }));
}
async function clearHit(key) {
  if (!configured()) { delete mem.counters['h:' + key]; return; }
  await sb('DELETE', 'counters?key=eq.' + q(key), undefined, 'return=minimal');
}

/* ---------- ids, passwords, tokens ---------- */
// The 'kitchen-line:' text is the site's original name. It is part of every account id, so it must never change.
const emailId = email => crypto.createHash('sha256').update('kitchen-line:' + email).digest('hex').slice(0, 32);
const normEmail = v => String(v || '').trim().toLowerCase();
const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 200;
function pbkdf2(pw, salt, iter) {
  return new Promise((res, rej) => crypto.pbkdf2(Buffer.from(pw, 'utf8'), salt, iter, 32, 'sha256', (e, k) => e ? rej(e) : res(k)));
}
// Same recipe the page always used (email + newline + password, PBKDF2-SHA-256), so existing passwords keep working.
async function makeCred(email, pw) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('base64'), hash: (await pbkdf2(email + '\n' + pw, salt, PW_ITER)).toString('base64'), iter: PW_ITER, setAt: Date.now() };
}
async function checkCred(cred, email, pw) {
  if (!cred || !cred.salt || !cred.hash) return false;
  const got = await pbkdf2(email + '\n' + pw, Buffer.from(cred.salt, 'base64'), cred.iter || PW_ITER);
  const want = Buffer.from(cred.hash, 'base64');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function secret() {
  const s = process.env.AUTH_SECRET;
  if (s && s.length >= 16) return s;
  if (IS_PROD) throw httpErr(500, 'AUTH_SECRET is not set (use a random string of 32+ characters).');
  return 'local-dev-only-secret';
}
const b64u = b => Buffer.from(b).toString('base64url');
const sig = body => crypto.createHmac('sha256', secret()).update(body).digest('base64url');
// A signed, expiring blob: used for login tokens (no "t" field) and for emailed reset links (t: 'reset').
function signPayload(obj, ttlMs) {
  const body = b64u(JSON.stringify(Object.assign({}, obj, { exp: Date.now() + ttlMs })));
  return body + '.' + sig(body);
}
function verifyPayload(token) {
  const [body, s] = String(token || '').split('.');
  if (!body || !s) return null;
  const want = sig(body);
  if (s.length !== want.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want))) return null;
  const p = parse(Buffer.from(body, 'base64url').toString('utf8'));
  return p && p.exp > Date.now() ? p : null;
}
const signToken = id => signPayload({ id }, TOKEN_DAYS * 86400000);
function readToken(req) {
  const h = String(req.headers.authorization || '');
  const p = verifyPayload(h.startsWith('Bearer ') ? h.slice(7) : '');
  return p && p.id && !p.t ? p : null;   // a reset link (t: 'reset') is never a login
}

/* ---------- email (password reset links) ----------
   Set RESEND_API_KEY or BREVO_API_KEY, plus EMAIL_FROM (an address the service has verified).
   With neither set, local runs print the link instead; production refuses to send. */
const MAIL_FROM = process.env.EMAIL_FROM || '';
const mailReady = () => !!(MAIL_FROM && (process.env.RESEND_API_KEY || process.env.BREVO_API_KEY));
const fromAddress = () => (/<([^>]+)>/.exec(MAIL_FROM) || [null, MAIL_FROM])[1].trim();
async function sendMail(to, subject, text, html) {
  let r;
  if (process.env.RESEND_API_KEY) {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM.includes('<') ? MAIL_FROM : 'MPC <' + MAIL_FROM + '>', to: [to], subject, text, html })
    });
  } else if (process.env.BREVO_API_KEY) {
    r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: 'MPC', email: fromAddress() }, to: [{ email: to }], subject, textContent: text, htmlContent: html })
    });
  } else throw httpErr(503, 'Email is not set up.');
  if (!r.ok) throw httpErr(502, 'The email could not be sent. Try again in a few minutes.');
}

/* ---------- throttling ---------- */
async function throttle(key, max, seconds) {
  if ((await hit('rl:' + key, seconds)) > max) throw httpErr(429, 'Too many tries. Wait a few minutes and try again.');
}
const clearThrottle = key => clearHit('rl:' + key);
const clientIp = req => String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'ip').split(',')[0].trim();

/* ---------- roles and permissions (same table as the page) ---------- */
const FEATURE_KEYS = ['view', 'join', 'roster', 'host', 'edit', 'remove', 'people', 'options', 'moveplayers', 'book', 'bookconfig', 'managebookings', 'viewbookers'];
const ALL_ON = {}; FEATURE_KEYS.forEach(k => { ALL_ON[k] = true; });
const DEFAULTS = {
  admin: { view: true, join: true, roster: true, host: true, edit: true, remove: true, people: true, options: true, moveplayers: true, book: true, bookconfig: true, managebookings: true, viewbookers: true },
  staff: { view: true, join: true, roster: true, host: true, edit: true, remove: false, people: false, options: true, moveplayers: false, book: true, bookconfig: false, managebookings: false, viewbookers: false },
  player: { view: true, join: true, roster: true, host: false, edit: false, remove: false, people: false, options: false, moveplayers: false, book: true, bookconfig: false, managebookings: false, viewbookers: false }
};
function permsFor(role, cfgDefs) {
  if (role === 'super_admin') return ALL_ON;
  const sd = (cfgDefs && cfgDefs[role]) || null;
  const base = DEFAULTS[role] || (sd ? { view: true, join: true, roster: true, book: true } : DEFAULTS.player);
  return Object.assign({}, base, (sd && sd.perms) || {});
}
async function whoIs(req) {
  const tok = readToken(req);
  if (!tok) throw httpErr(401, 'Please log in again.');
  const [member, roleDoc, cfg] = await Promise.all([getDoc('members', tok.id), getDoc('roles', tok.id), getDoc('config', 'roles')]);
  if (!member) throw httpErr(401, 'This account no longer exists.');
  const defs = (cfg && cfg.defs) || {};
  let role = (roleDoc && roleDoc.role) || 'player';
  if (role !== 'super_admin' && !DEFAULTS[role] && !defs[role]) role = 'player';
  const perms = permsFor(role, defs);
  const suspended = !!(roleDoc && roleDoc.suspended);
  return {
    uid: tok.id, member, role, defs, suspended,
    isSuper: role === 'super_admin',
    can: k => !suspended && perms[k] === true
  };
}

/* ---------- time (sessions and bookings are wall-clock times in APP_TIMEZONE) ---------- */
function tzOffset(ts) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ts));
  const o = {}; parts.forEach(p => { o[p.type] = Number(p.value); });
  return Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute, o.second) - Math.floor(ts / 1000) * 1000;
}
function wallToUtc(dateStr, hh, mm) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return NaN;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], hh, mm);
  return guess - tzOffset(guess - tzOffset(guess));
}
function sessionEnded(s) {
  if (!s || !s.date || !s.start) return false;
  const t = String(s.start).split(':').map(Number);
  const end = wallToUtc(s.date, t[0] || 0, t[1] || 0) + (Number(s.duration) || 90) * 60000;
  return end <= Date.now();
}
function bookingEnded(b) {
  if (!b || !b.date || typeof b.hour !== 'number') return false;
  return wallToUtc(b.date, b.hour + 1, 0) <= Date.now();
}

module.exports = {
  redis, one, K, COLS, parse, getDoc, bump, getRev, httpErr,
  emailId, normEmail, validEmail, makeCred, checkCred, signToken, readToken, signPayload, verifyPayload, mailReady, sendMail, IS_PROD,
  throttle, clearThrottle, clientIp, whoIs, sessionEnded, bookingEnded, FEATURE_KEYS, DEFAULTS
};
