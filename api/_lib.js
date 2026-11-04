/* Shared server code for the MPC API (Vercel Node functions).
   Storage: Upstash Redis over its REST API (no npm packages needed). With no Redis variables set and
   NODE_ENV not "production", an in-memory store is used so the site can be tried locally. */
'use strict';
const crypto = require('crypto');

const REST_URL = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
const TZ = process.env.APP_TIMEZONE || 'Asia/Manila';
const PW_ITER = 200000;
const TOKEN_DAYS = 30;

/* ---------- storage ---------- */
const mem = { hashes: {}, strings: {} };
function memRun(cmd) {
  const op = String(cmd[0]).toUpperCase(), k = cmd[1];
  const hash = () => (mem.hashes[k] = mem.hashes[k] || {});
  switch (op) {
    case 'HGET': return (mem.hashes[k] || {})[cmd[2]] ?? null;
    case 'HSET': hash()[cmd[2]] = cmd[3]; return 1;
    case 'HSETNX': if (cmd[2] in hash()) return 0; hash()[cmd[2]] = cmd[3]; return 1;
    case 'HDEL': { const had = cmd[2] in (mem.hashes[k] || {}); if (had) delete mem.hashes[k][cmd[2]]; return had ? 1 : 0; }
    case 'HGETALL': { const o = mem.hashes[k] || {}; const a = []; Object.keys(o).forEach(f => a.push(f, o[f])); return a; }
    case 'GET': return mem.strings[k] ?? null;
    case 'INCR': mem.strings[k] = String((Number(mem.strings[k]) || 0) + 1); return Number(mem.strings[k]);
    case 'DEL': delete mem.strings[k]; delete mem.hashes[k]; return 1;
    case 'EXPIRE': return 1;
    default: throw new Error('memory store: unsupported ' + op);
  }
}
async function redis(cmds) {
  if (!REST_URL || !REST_TOKEN) {
    if (IS_PROD) throw httpErr(500, 'The database is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
    return cmds.map(memRun);
  }
  const r = await fetch(REST_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw httpErr(502, 'The database did not answer (' + r.status + ').');
  const out = await r.json();
  return out.map(x => { if (x.error) throw httpErr(502, 'Database error: ' + x.error); return x.result; });
}
const one = async cmd => (await redis([cmd]))[0];
const K = col => 'mpc:c:' + col;
const COLS = ['sessions', 'signups', 'members', 'roles', 'bookings', 'config', 'logins'];
const parse = s => { if (s == null) return null; try { return JSON.parse(s); } catch (e) { return null; } };
const getDoc = async (col, id) => parse(await one(['HGET', K(col), id]));
async function bump() { await one(['INCR', 'mpc:rev']); }

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

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
function signToken(id) {
  const body = b64u(JSON.stringify({ id, exp: Date.now() + TOKEN_DAYS * 86400000 }));
  return body + '.' + crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}
function readToken(req) {
  const h = String(req.headers.authorization || '');
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [body, sig] = t.split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  const p = parse(Buffer.from(body, 'base64url').toString('utf8'));
  return p && p.id && p.exp > Date.now() ? p : null;
}

/* ---------- throttling ---------- */
async function throttle(key, max, seconds) {
  const [n] = await redis([['INCR', 'mpc:rl:' + key], ['EXPIRE', 'mpc:rl:' + key, seconds]]);
  if (n > max) throw httpErr(429, 'Too many tries. Wait a few minutes and try again.');
}
const clearThrottle = key => one(['DEL', 'mpc:rl:' + key]);
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
  redis, one, K, COLS, parse, getDoc, bump, httpErr,
  emailId, normEmail, validEmail, makeCred, checkCred, signToken, readToken,
  throttle, clearThrottle, clientIp, whoIs, sessionEnded, bookingEnded, FEATURE_KEYS, DEFAULTS
};
