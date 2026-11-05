/* Booking, payment and notification logic shared by /api/pay and /api/data (server side only). */
'use strict';
const crypto = require('crypto');
const L = require('./_lib');

const HOLD_MS = 15 * 60000;          // how long picked hours are held while the player pays
const RETRY_HOLD_MS = 30 * 60000;    // after a payment is denied, how long the hours stay held for a corrected resubmission
const DEFAULT_HOURS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
const DEFAULT_RATES = [{ from: 7, to: 17, price: 200 }, { from: 17, to: 22, price: 300 }];
const DEFAULT_POLICY = [{ hours: 48, percent: 100 }, { hours: 24, percent: 50 }, { hours: 0, percent: 0 }];
const pad = n => String(n).padStart(2, '0');

/* ---------- configuration ---------- */
async function bookingCfg() {
  const s = (await L.getDoc('config', 'booking')) || {};
  const hours = [], rates = [];
  (Array.isArray(s.hours) ? s.hours : []).forEach(x => { x = parseInt(x, 10); if (x >= 0 && x <= 23 && hours.indexOf(x) < 0) hours.push(x); });
  (Array.isArray(s.rates) ? s.rates : []).forEach(r => {
    const f = parseInt(r && r.from, 10), t = parseInt(r && r.to, 10), p = parseInt(r && r.price, 10);
    if (f >= 0 && t <= 24 && t > f && p > 0) rates.push({ from: f, to: t, price: p });
  });
  hours.sort((a, b) => a - b);
  return { hours: hours.length ? hours : DEFAULT_HOURS.slice(), rates: rates.length ? rates : DEFAULT_RATES.map(r => Object.assign({}, r)), courts: s.courts };
}
const priceOf = (cfg, hour) => { const r = cfg.rates.find(x => hour >= x.from && hour < x.to); return r ? r.price : null; };
async function columns(cfg) {
  const out = [], seen = {};
  (Array.isArray(cfg.courts) ? cfg.courts : []).forEach(c => {
    const name = String((c && c.name) || '').trim(), venue = String((c && c.venue) || '').trim(), k = (venue + '|' + name).toLowerCase();
    if (name && !seen[k]) { seen[k] = 1; out.push({ name, venue }); }
  });
  if (out.length) return out;
  const o = (await L.getDoc('config', 'options')) || {};
  const names = Array.isArray(o.courts) && o.courts.length ? o.courts : ['Court 1', 'Court 2', 'Court 3', 'Court 4'];
  const venues = Array.isArray(o.venues) ? o.venues : [];
  if (!venues.length) return names.map(n => ({ name: n, venue: '' }));
  venues.forEach(v => names.forEach(n => out.push({ name: n, venue: v })));
  return out;
}
async function payCfg() {
  const c = (await L.getDoc('config', 'payment')) || {};
  const policy = Array.isArray(c.refundPolicy) && c.refundPolicy.length ? c.refundPolicy : DEFAULT_POLICY;
  return { gcashNumber: c.gcashNumber || '', accountName: c.accountName || '', qrPath: c.qrPath || '', refundPolicy: normPolicy(policy) };
}
function normPolicy(p) {
  const out = [];
  (p || []).forEach(x => { const h = Number(x && x.hours), pc = Number(x && x.percent); if (h >= 0 && h <= 720 && pc >= 0 && pc <= 100) out.push({ hours: Math.round(h), percent: Math.round(pc) }); });
  out.sort((a, b) => b.hours - a.hours);
  return out.length ? out : DEFAULT_POLICY.map(x => Object.assign({}, x));
}
// Share of the amount paid that comes back if the booking is cancelled this many hours before it starts.
function refundPercent(policy, hoursUntil) {
  for (const t of policy) if (hoursUntil >= t.hours) return t.percent;
  return 0;
}

/* ---------- slots ---------- */
const slug = x => String(x).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const slotId = (date, venue, court, hour) => date + '_' + (venue ? slug(venue) + '_' : '') + slug(court) + '_' + pad(hour);
const courtKey = x => String(x || '').toLowerCase().replace(/^courts?\s*/, '').trim();
const startMs = (date, hour) => L.wallToUtc(date, hour, 0);
// A slot keeps its court busy while it is paid, waiting for verification, part of a pending move, or a hold that has not run out.
function occupies(b, now) {
  if (!b || !b.by) return false;
  if (b.status === 'hold') return Number(b.holdUntil) > (now || Date.now());
  return true;   // confirmed, pending, resched, and bookings made before payments existed (no status)
}
async function allMap(col) {
  const flat = await L.one(['HGETALL', L.K(col)]), out = {};
  for (let i = 0; i < flat.length; i += 2) { const d = L.parse(flat[i + 1]); if (d) out[flat[i]] = d; }
  return out;
}
const sameVenue = (a, b) => !a || !b || a === '-' || b === '-' || String(a).toLowerCase() === String(b).toLowerCase();
// A session that uses this court at this hour (sessions with no court, "-", never block anything).
function sessionBlocking(sessions, slot) {
  const ck = courtKey(slot.court), lo = slot.hour * 60, hi = lo + 60;
  return Object.keys(sessions).map(id => Object.assign({ id }, sessions[id])).find(s => {
    if (s.date !== slot.date || !courtKey(s.court) || courtKey(s.court) === '-' || courtKey(s.court) !== ck) return false;
    if (!sameVenue(slot.venue, s.venue)) return false;
    const t = String(s.start || '').split(':').map(Number), a = (t[0] || 0) * 60 + (t[1] || 0), z = a + (Number(s.duration) || 90);
    return a < hi && z > lo;
  }) || null;
}
// A booked hour that overlaps this session (same court, same venue, overlapping time).
function bookingBlocking(bookings, session, now) {
  const ck = courtKey(session.court);
  if (!ck || ck === '-') return null;
  const t = String(session.start || '').split(':').map(Number), a = (t[0] || 0) * 60 + (t[1] || 0), z = a + (Number(session.duration) || 90);
  const id = Object.keys(bookings).find(k => {
    const b = bookings[k];
    if (!occupies(b, now) || b.date !== session.date || courtKey(b.court) !== ck || !sameVenue(b.venue, session.venue)) return false;
    return a < b.hour * 60 + 60 && z > b.hour * 60;
  });
  return id ? Object.assign({ id }, bookings[id]) : null;
}

/* ---------- people ---------- */
// Everyone whose role includes a permission (suspended accounts excluded).
async function usersWith(perm) {
  const [members, roles, cfg] = await Promise.all([allMap('members'), allMap('roles'), L.getDoc('config', 'roles')]);
  const defs = (cfg && cfg.defs) || {};
  return Object.keys(members).filter(uid => {
    const r = roles[uid] || {};
    if (r.suspended) return false;
    let role = r.role || 'player';
    if (role !== 'super_admin' && !L.DEFAULTS[role] && !defs[role]) role = 'player';
    if (role === 'super_admin') return true;
    const base = L.DEFAULTS[role] || { view: true, join: true, roster: true, book: true };
    const sd = defs[role];
    return Object.assign({}, base, (sd && sd.perms) || {})[perm] === true;
  });
}
// Staff assigned to a venue (set on the Users page as roles/{id}.venues).
async function venueStaff(venue) {
  if (!venue) return [];
  const roles = await allMap('roles'), v = String(venue).toLowerCase();
  return Object.keys(roles).filter(uid => !roles[uid].suspended && Array.isArray(roles[uid].venues) && roles[uid].venues.some(x => String(x).toLowerCase() === v));
}

/* ---------- notifications: created only by server events, each exactly once ---------- */
const safeId = s => String(s).replace(/[^A-Za-z0-9_.\-]/g, '_').slice(0, 190);
async function notify(uids, spec) {
  const made = [];
  for (const uid of Array.from(new Set(uids))) {
    const id = safeId(spec.event + '.' + spec.refId + '.' + uid);
    const doc = { to: uid, kind: spec.kind || spec.event, title: spec.title, body: spec.body, data: spec.data || {}, at: Date.now(), read: spec.read === true };
    if (!(await L.one(['HSETNX', L.K('notifications'), id, JSON.stringify(doc)]))) continue;   // this event was already announced to this person
    made.push(id);
    if (spec.read === true) continue;
    try {
      const r = await pushTo(uid, { title: spec.title, body: spec.body, data: Object.assign({}, spec.data, { kind: doc.kind, nid: id }) });
      if (r && (r.sent || r.failed)) await L.one(['HSET', L.K('notifications'), id, JSON.stringify(Object.assign(doc, { push: { sent: r.sent || 0, failed: r.failed || 0 } }))]);
    } catch (e) { console.error('push failed:', e && e.message); }
  }
  return made;
}

/* ---------- phone push (Firebase Cloud Messaging, HTTP v1) ---------- */
function firebaseAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  for (const s of [raw, (() => { try { return Buffer.from(raw, 'base64').toString('utf8'); } catch (e) { return ''; } })()]) {
    try { const j = JSON.parse(s); if (j.client_email && j.private_key && j.project_id) return j; } catch (e) { /* try the next form */ }
  }
  return null;
}
let fcmToken = null;
async function fcmAccessToken(sa) {
  if (fcmToken && fcmToken.exp > Date.now() + 60000) return fcmToken.t;
  const now = Math.floor(Date.now() / 1000), b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const jwt = unsigned + '.' + crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Firebase sign-in failed (' + r.status + ').');
  fcmToken = { t: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return fcmToken.t;
}
// Sends one notification to every device a person registered. Dead tokens are removed. Returns counts; never throws on a bad device.
async function pushTo(uid, n) {
  const sa = firebaseAccount();
  if (!sa) return { skipped: 'Firebase is not set up' };
  const doc = await L.getDoc('pushtokens', uid), tokens = (doc && doc.tokens) || [];
  if (!tokens.length) return { sent: 0, failed: 0 };
  const access = await fcmAccessToken(sa), keep = [];
  let sent = 0, failed = 0;
  const data = {};
  Object.keys(n.data || {}).forEach(k => { data[k] = String((n.data || {})[k]); });
  data.title = n.title; data.body = n.body;   // data-only message: the service worker shows it, so it appears even with the site closed
  for (const tk of tokens) {
    const r = await fetch('https://fcm.googleapis.com/v1/projects/' + sa.project_id + '/messages:send', {
      method: 'POST', headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token: tk.t, data, webpush: { headers: { Urgency: 'high', TTL: '86400' } } } })
    });
    if (r.ok) { sent++; keep.push(tk); continue; }
    const j = await r.json().catch(() => ({})), st = (j.error && j.error.status) || '';
    if (r.status === 404 || st === 'NOT_FOUND' || st === 'UNREGISTERED' || st === 'INVALID_ARGUMENT') continue;   // expired or invalid device: forget it
    failed++; keep.push(tk);
  }
  if (keep.length !== tokens.length) await L.one(['HSET', L.K('pushtokens'), uid, JSON.stringify({ tokens: keep })]);
  return { sent, failed };
}

/* ---------- small helpers ---------- */
const money = n => '₱' + Number(n).toLocaleString('en-PH');
const hourText = hr => (hr % 12 || 12) + ':00 ' + (hr % 24 < 12 ? 'AM' : 'PM');
const dateText = d => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); };
const refCode = () => { const c = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', b = crypto.randomBytes(6); return 'MPC-' + Array.from(b).map(v => c[v % c.length]).join(''); };
// "Court 2 · Venue, Sat, Nov 7, 4:00 PM – 6:00 PM" for a list of slot docs of one booking
function scheduleText(slots) {
  const s = slots.slice().sort((a, b) => (a.date + a.venue + a.court + pad(a.hour)) < (b.date + b.venue + b.court + pad(b.hour)) ? -1 : 1), runs = [];
  s.forEach(x => {
    const l = runs[runs.length - 1];
    if (l && l.date === x.date && l.court === x.court && (l.venue || '') === (x.venue || '') && l.to === x.hour) l.to = x.hour + 1;
    else runs.push({ date: x.date, court: x.court, venue: x.venue || '', from: x.hour, to: x.hour + 1 });
  });
  return runs.map(r => r.court + (r.venue ? ' · ' + r.venue : '') + ', ' + dateText(r.date) + ', ' + hourText(r.from) + ' – ' + hourText(r.to)).join('; ');
}

module.exports = {
  HOLD_MS, RETRY_HOLD_MS, DEFAULT_POLICY, bookingCfg, priceOf, columns, payCfg, normPolicy, refundPercent,
  slotId, courtKey, startMs, occupies, allMap, sameVenue, sessionBlocking, bookingBlocking,
  usersWith, venueStaff, notify, pushTo, firebaseAccount, money, hourText, dateText, refCode, scheduleText, safeId, pad
};
