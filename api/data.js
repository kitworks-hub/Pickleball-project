/* GET  /api/data?rev=N   -> everything the page shows (or { same: true } when nothing changed since rev N)
   POST /api/data         -> { op: 'add' | 'set' | 'update' | 'delete' | 'acquire', path, data }
   Every call needs the token from /api/auth. Writes are checked here against the same role table the page uses. */
'use strict';
const crypto = require('crypto');
const L = require('./_lib');

const READ_COLS = ['sessions', 'signups', 'members', 'roles', 'bookings'];
const ID_RE = /^[A-Za-z0-9_.\-]{1,200}$/;
const forbid = msg => L.httpErr(403, msg || 'Your role cannot do that.');
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

function mapOf(flat) {
  const out = {};
  for (let i = 0; i < flat.length; i += 2) { const d = L.parse(flat[i + 1]); if (d) out[flat[i]] = d; }
  return out;
}

async function read(req, res) {
  await L.whoIs(req);
  const want = Number(req.query && req.query.rev);
  const rev = await L.getRev();
  if (want === rev) return res.status(200).json({ rev, same: true });
  const r = await L.redis(READ_COLS.concat(['config']).map(c => ['HGETALL', L.K(c)]));
  const cols = {};
  READ_COLS.forEach((c, i) => { cols[c] = mapOf(r[i]); });
  res.status(200).json({ rev, cols, config: mapOf(r[READ_COLS.length]) });
}

/* ---------- write rules: return the document to store (or null to delete) ---------- */
const rules = {
  sessions(w, id, next, cur) {
    if (next === null) {
      if (w.can('remove') || (cur.hostId === w.uid && w.can('host')) || L.sessionEnded(cur)) return null;   // ended sessions are tidied up by any signed-in viewer
      throw forbid();
    }
    if (!isObj(next)) throw L.httpErr(400, 'Bad session.');
    if (!cur) {
      if (!w.can('host')) throw forbid('Your role cannot add sessions.');
      return Object.assign({}, next, { hostId: w.uid, hostName: w.member.name, createdAt: Date.now() });
    }
    if (!(w.can('edit') || (cur.hostId === w.uid && w.can('host')))) throw forbid('Your role cannot edit this session.');
    return Object.assign({}, next, { hostId: cur.hostId, hostName: cur.hostName, createdAt: cur.createdAt });
  },

  signups(w, id, next, cur) {
    const mine = id === w.uid;
    if (next === null) {
      if (w.can('moveplayers') || w.isSuper) return null;
      throw forbid();
    }
    if (!isObj(next)) throw L.httpErr(400, 'Bad sign-up.');
    if (mine ? !(w.can('join') || w.can('moveplayers')) : !w.can('moveplayers')) throw forbid('Your role cannot change sign-ups.');
    return { joined: isObj(next.joined) ? next.joined : {}, name: String(next.name || '').slice(0, 80) };
  },

  members(w, id, next, cur) {
    if (next === null) {
      if (w.isSuper && id !== w.uid) return null;
      throw forbid('Only a super admin can remove a member.');
    }
    if (!cur || id !== w.uid) throw forbid('You can only change your own profile.');
    if (!isObj(next)) throw L.httpErr(400, 'Bad profile.');
    const out = Object.assign({}, cur, { name: String(next.name || cur.name).trim().slice(0, 80) || cur.name });
    const r = Number(next.rating);
    if (next.rating != null && r >= 1 && r <= 6) out.rating = r; else delete out.rating;
    return out;   // createdAt and pwSetAt can only change through /api/auth
  },

  roles(w, id, next, cur) {
    if (!w.can('people')) throw forbid('Your role cannot manage users.');
    if (id === w.uid) throw forbid('You cannot change your own role.');
    if (cur && cur.owner) throw forbid('The owner account cannot be changed here.');
    const targetRole = (cur && cur.role) || 'player';
    if (!w.isSuper && (targetRole === 'super_admin' || targetRole === 'admin')) throw forbid('Only a super admin can change an admin.');
    if (next === null) {
      if (!w.isSuper) throw forbid();
      return null;
    }
    if (!isObj(next)) throw L.httpErr(400, 'Bad role.');
    const role = String(next.role || 'player').slice(0, 40);
    if (!w.isSuper && (role === 'super_admin' || role === 'admin')) throw forbid('Only a super admin can make an admin.');
    const out = { role, by: w.uid, at: Date.now() };
    if (next.suspended) out.suspended = true;
    if (next.pwReset) out.pwReset = Number(next.pwReset) || Date.now();
    return out;
  },

  config(w, id, next, cur) {
    if (next === null) throw forbid();
    if (!isObj(next)) throw L.httpErr(400, 'Bad settings.');
    if (id === 'roles') {
      if (!w.isSuper) throw forbid('Only a super admin can change role access.');
      const defs = isObj(next.defs) ? Object.assign({}, next.defs) : {};
      delete defs.super_admin;
      return { defs };
    }
    if (id === 'options') {
      if (!(w.can('options') || w.can('bookconfig'))) throw forbid();
      return next;
    }
    if (id === 'booking') {
      if (!w.can('bookconfig')) throw forbid();
      return next;
    }
    throw forbid();
  },

  bookings(w, id, next, cur, op) {
    const leased = cur && !cur.by;                                   // a lease-only placeholder
    const leaseMine = leased && cur.lease && String(cur.lease.holder || '').startsWith(w.uid + ':');
    const leaseLive = leased && cur.lease && cur.lease.until > Date.now() && !leaseMine;
    if (next === null) {
      if (w.can('managebookings')) return null;
      if (leased && (leaseMine || !leaseLive)) return null;                              // giving back a claim
      if (cur.by === w.uid && Date.now() - Number(cur.at || 0) < 120000) return null;     // undoing a half-finished booking
      if (L.bookingEnded(cur)) return null;                                              // tidying past hours
      throw forbid('Only roles with Manage Bookings can cancel bookings.');
    }
    if (!isObj(next)) throw L.httpErr(400, 'Bad booking.');
    if (op === 'update') {
      if (!w.can('managebookings') || !cur || !cur.by) throw forbid();
      return Object.assign({}, cur, next, { by: cur.by });
    }
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(String(next.date || '')) && Number.isInteger(next.hour) && next.hour >= 0 && next.hour <= 23 && next.court;
    if (!valid) throw L.httpErr(400, 'Bad booking.');
    const mine = next.by === w.uid;
    if (!(mine ? w.can('book') : w.can('managebookings'))) throw forbid('Your role cannot book courts.');
    if (cur && cur.by && !(w.can('managebookings') && cur.by === next.by)) throw L.httpErr(409, 'That hour was just booked.');
    if (leaseLive) throw L.httpErr(409, 'That hour was just booked.');
    return {
      date: next.date, venue: String(next.venue || ''), court: String(next.court), hour: next.hour, by: String(next.by),
      byName: mine ? w.member.name : String(next.byName || '').slice(0, 80), ref: String(next.ref || '').slice(0, 40), price: Number(next.price) || 0,
      at: Number(next.at) || Date.now()
    };
  }
};

async function write(req, res) {
  const w = await L.whoIs(req);
  if (w.suspended) throw forbid('Your access is paused.');
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const parts = String(b.path || '').split('/');
  const col = parts[0];
  let id = parts[1];
  const op = b.op;
  if (L.COLS.indexOf(col) < 0 || col === 'logins' && !(op === 'delete' && w.isSuper)) throw forbid();
  if (op === 'add') {
    if (col !== 'sessions' || parts.length !== 1) throw forbid();
    id = crypto.randomBytes(10).toString('hex');
  } else if (!id || !ID_RE.test(id) || parts.length !== 2) throw L.httpErr(400, 'Bad path.');
  if (b.data !== undefined && !isObj(b.data) && op !== 'delete') throw L.httpErr(400, 'Bad data.');

  const cur = op === 'add' ? null : await L.getDoc(col, id);

  if (col === 'logins') {   // only a super admin removing someone else's account
    if (id === w.uid) throw forbid();
    await L.one(['HDEL', L.K('logins'), id]);
    await L.bump();
    return res.status(200).json({ ok: true });
  }

  if (op === 'acquire') {
    if (col !== 'bookings') throw forbid();
    if (!(w.can('book') || w.can('managebookings'))) throw forbid('Your role cannot book courts.');
    const holder = String((b.data && b.data.holder) || '');
    if (!holder.startsWith(w.uid + ':')) throw L.httpErr(400, 'Bad claim.');
    if (cur && cur.by) return res.status(200).json({ acquired: false });
    if (cur && cur.lease && cur.lease.until > Date.now() && cur.lease.holder !== holder && !String(cur.lease.holder).startsWith(w.uid + ':')) return res.status(200).json({ acquired: false });
    const ttl = Math.min(30000, Math.max(1000, Number(b.data && b.data.ttlMs) || 10000));
    const doc = JSON.stringify({ lease: { holder, until: Date.now() + ttl } });
    const claimed = cur ? (await L.one(['HSET', L.K('bookings'), id, doc]), true) : !!(await L.one(['HSETNX', L.K('bookings'), id, doc]));
    return res.status(200).json({ acquired: claimed });
  }

  if (['set', 'update', 'delete', 'add'].indexOf(op) < 0) throw L.httpErr(400, 'Unknown operation.');
  if (op === 'delete' && !cur) return res.status(200).json({ ok: true });
  if (op !== 'add' && op !== 'set' && op !== 'delete' && !cur) throw L.httpErr(404, 'Not found.');

  let next;
  if (op === 'delete') next = null;
  else if (op === 'update') next = Object.assign({}, cur, b.data);
  else next = b.data || {};

  const out = rules[col](w, id, next, cur, op);

  if (out === null) await L.one(['HDEL', L.K(col), id]);
  else if (col === 'bookings' && !cur) {
    if (!(await L.one(['HSETNX', L.K(col), id, JSON.stringify(out)]))) throw L.httpErr(409, 'That hour was just booked.');
  } else await L.one(['HSET', L.K(col), id, JSON.stringify(out)]);
  await L.bump();
  res.status(200).json({ ok: true, id });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') return await read(req, res);
    if (req.method === 'POST') return await write(req, res);
    throw L.httpErr(405, 'Use GET or POST.');
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('data error:', e && e.message);
    res.status(status).json({ error: status >= 500 && !e.status ? 'Something went wrong.' : e.message });
  }
};
