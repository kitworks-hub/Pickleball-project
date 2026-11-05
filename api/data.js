/* GET  /api/data?rev=N   -> everything the page shows (or { same: true } when nothing changed since rev N)
   POST /api/data         -> { op: 'add' | 'set' | 'update' | 'delete' | 'acquire', path, data }
   Every call needs the token from /api/auth. Writes are checked here against the same role table the page uses. */
'use strict';
const crypto = require('crypto');
const L = require('./_lib');
const B = require('./_book');

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
  const w = await L.whoIs(req);
  const want = Number(req.query && req.query.rev);
  const rev = await L.getRev();
  if (want === rev) return res.status(200).json({ rev, same: true });
  const names = READ_COLS.concat(['payments', 'refunds', 'notifications', 'refundaccts', 'balances', 'ledger', 'balancelinks', 'config']);
  const r = await L.redis(names.map(c => ['HGETALL', L.K(c)]));
  const cols = {};
  names.slice(0, -1).forEach((c, i) => { cols[c] = mapOf(r[i]); });
  const config = mapOf(r[names.length - 1]);
  const now = Date.now(), staffSees = w.can('managebookings') || w.can('payments');
  Object.keys(cols.bookings).forEach(id => {
    const b = cols.bookings[id];
    if (!b.by || (b.status === 'hold' && Number(b.holdUntil) <= now)) { delete cols.bookings[id]; return; }   // claims with no owner, and holds that ran out
    if (b.by !== w.uid && !staffSees) { delete b.paid; delete b.payId; delete b.moveFrom; }
  });
  // payments, refunds and notifications: staff with the permission see all, everyone else only their own
  const onlyMine = (col, perm, ownerField) => {
    if (perm && w.can(perm)) return;
    Object.keys(cols[col]).forEach(id => { if (cols[col][id][ownerField] !== w.uid) delete cols[col][id]; });
  };
  const onlyMineKeyed = (col, perm) => { if (perm && w.can(perm)) return; Object.keys(cols[col]).forEach(id => { if (id !== w.uid) delete cols[col][id]; }); };   // documents named after the person
  onlyMine('payments', 'payments', 'by'); onlyMine('refunds', 'refunds', 'by'); onlyMine('notifications', null, 'to'); onlyMine('ledger', 'refunds', 'uid');
  onlyMineKeyed('refundaccts', 'refunds'); onlyMineKeyed('balances', 'refunds');
  if (!w.canLinkBalances) cols.balancelinks = {};   // the audit history of balance links is for Super Admin and Admin only
  // A player's level always follows the levels in Session Configurations: one that is no longer offered is not shown (and is never kept in sync by hand)
  const levels = B.levelsOf(config.options);
  Object.keys(cols.members).forEach(id => { const m = cols.members[id]; if (m.level && levels.indexOf(m.level) < 0) { m.levelRemoved = m.level; delete m.level; } });
  // Refunds opened before players could choose a method look like what they are: waiting for the player. Reviewers also see what blocks each one.
  const locks = w.can('refunds') ? await B.allMap('locks') : null;
  Object.keys(cols.refunds).forEach(id => {
    const rf = cols.refunds[id];
    if (locks) rf.blockers = B.refundBlockers(id, rf, locks);   // worked out from the stored record, before it is shown as waiting
    if (B.isAwaiting(rf) && rf.status !== 'awaiting_user') { rf.legacyStatus = rf.status; rf.status = 'awaiting_user'; }
  });
  res.status(200).json({ rev, cols, config });
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
    return out;   // level and picture change only through /api/pay; the old rating is kept as it was; createdAt and pwSetAt only through /api/auth
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
    const venues = Array.isArray(next.venues) ? next.venues : (cur && cur.venues);
    if (Array.isArray(venues) && venues.length) out.venues = venues.map(v => String(v).slice(0, 60)).slice(0, 20);   // venues this person staffs: they are told about confirmed bookings there
    if (next.suspended) out.suspended = true;
    if (next.pwReset) out.pwReset = Number(next.pwReset) || Date.now();
    return out;
  },

  config(w, id, next, cur) {
    if (next === null) throw forbid();
    if (!isObj(next)) throw L.httpErr(400, 'Bad settings.');
    if (id === 'roles') {
      if (!w.can('roleaccess')) throw forbid('Your role cannot change role access.');
      const defs = isObj(next.defs) ? Object.assign({}, next.defs) : {};
      delete defs.super_admin;   // nobody can write a "super admin" role here: that role only comes from a super admin assigning it
      if (!w.isSuper) {          // admins manage the other roles, but only a super admin changes what Admins themselves can do
        const eff = d => JSON.stringify([((d && d.admin && d.admin.label) || 'Admin'), L.permsFor('admin', d)]);
        if (eff(defs) !== eff((cur && cur.defs) || {})) throw forbid('Only a super admin can change what Admins can do.');
      }
      return { defs };
    }
    if (id === 'options') {
      if (!(w.can('options') || w.can('bookconfig'))) throw forbid();
      return next;
    }
    if (id === 'payment') throw forbid('Payment settings are saved from the Payments page.');
    if (id === 'booking') {
      if (!w.can('bookconfig')) throw forbid();
      return next;
    }
    throw forbid();
  },

  bookings(w, id, next, cur, op) {
    // Bookings are made, paid for, moved and cancelled through /api/pay (it checks conflicts, prices and payments). The only thing
    // allowed here is tidying: an hour that has ended, or a hold that ran out.
    if (next === null && cur && (L.bookingEnded(cur) || !B.occupies(cur))) return null;
    throw forbid('Bookings are changed from the Book a Court page.');
  }
};

// What each change in the data API means, in words, for the audit trail.
const permDiff = (a, c) => { const out = []; Object.keys(Object.assign({}, a, c)).forEach(k => { if (!!(a || {})[k] !== !!(c || {})[k]) out.push(((c || {})[k] ? '+' : '-') + k); }); return out; };
async function auditWrite(w, col, id, op, cur, out, wasSigns) {
  try {
    const who = async uid => { const m = await L.getDoc('members', uid); return { id: uid, name: (m && m.name) || uid }; };
    if (col === 'sessions') {
      if (out === null) return L.audit(w, 'session.delete', 'Removed session "' + ((cur && cur.title) || id) + '" (' + (cur && cur.date) + ' ' + (cur && cur.start) + ')', { refs: { sessionId: id }, before: cur && { title: cur.title, date: cur.date, start: cur.start, court: cur.court, venue: cur.venue } });
      const keys = ['title', 'date', 'start', 'duration', 'court', 'venue', 'level', 'format', 'capacity'], pick = o => keys.reduce((n, k) => { n[k] = o[k]; return n; }, {});
      if (!cur) return L.audit(w, 'session.create', 'Added session "' + out.title + '" (' + out.date + ' ' + out.start + ')', { refs: { sessionId: id }, after: pick(out) });
      const ch = keys.filter(k => String(cur[k]) !== String(out[k]));
      if (ch.length) return L.audit(w, 'session.update', 'Edited session "' + out.title + '": ' + ch.join(', '), { refs: { sessionId: id }, before: ch.reduce((n, k) => { n[k] = cur[k]; return n; }, {}), after: ch.reduce((n, k) => { n[k] = out[k]; return n; }, {}) });
      return;
    }
    if (col === 'signups') {
      const now = out ? Object.keys(out.joined || {}) : [], added = now.filter(s => wasSigns.indexOf(s) < 0), removed = wasSigns.filter(s => now.indexOf(s) < 0);
      if (!added.length && !removed.length) return;
      const subj = await who(id), title = async s => { const d = await L.getDoc('sessions', s); return d ? d.title : s; };
      const act = id === w.uid ? '' : ' (by ' + w.member.name + ')';
      if (added.length && removed.length) return L.audit(w, 'session.move', subj.name + ' moved from "' + (await title(removed[0])) + '" to "' + (await title(added[0])) + '"' + act, { subject: subj, refs: { from: removed[0], to: added[0] } });
      if (added.length) return L.audit(w, 'session.join', subj.name + ' joined "' + (await title(added[0])) + '"' + act, { subject: subj, refs: { sessionId: added[0] } });
      return L.audit(w, 'session.leave', subj.name + ' was removed from "' + (await title(removed[0])) + '"' + act, { subject: subj, refs: { sessionId: removed[0] } });
    }
    if (col === 'members') {
      if (out === null) return L.audit(w, 'account.remove', w.member.name + ' removed the account of ' + ((cur && cur.name) || id), { subject: { id, name: cur && cur.name } });
      if (cur && cur.name !== out.name) return L.audit(w, 'account.profile', (cur.name) + ' changed their name to ' + out.name, { subject: { id, name: out.name }, before: { name: cur.name }, after: { name: out.name } });
      return;
    }
    if (col === 'roles') {
      const subj = await who(id), was = (cur && cur.role) || 'player';
      if (out === null) return L.audit(w, 'role.remove', 'Reset the role of ' + subj.name + ' (was ' + was + ')', { subject: subj, before: { role: was } });
      if (out.role !== was) await L.audit(w, 'role.change', 'Changed the role of ' + subj.name + ' from ' + was + ' to ' + out.role, { subject: subj, before: { role: was }, after: { role: out.role } });
      if (!!out.suspended !== !!(cur && cur.suspended)) await L.audit(w, out.suspended ? 'account.suspend' : 'account.resume', (out.suspended ? 'Paused access for ' : 'Restored access for ') + subj.name, { subject: subj });
      if (out.pwReset && out.pwReset !== (cur && cur.pwReset)) await L.audit(w, 'account.password_reset', 'Started a password reset for ' + subj.name, { subject: subj });
      if (JSON.stringify(out.venues || []) !== JSON.stringify((cur && cur.venues) || [])) await L.audit(w, 'role.venues', 'Changed the venues of ' + subj.name, { subject: subj, before: { venues: (cur && cur.venues) || [] }, after: { venues: out.venues || [] } });
      return;
    }
    if (col === 'config') {
      if (id === 'roles') {
        const a = (cur && cur.defs) || {}, c = (out && out.defs) || {}, lines = [];
        Object.keys(Object.assign({}, a, c)).forEach(k => {
          if (!a[k]) lines.push('added role ' + k); else if (!c[k]) lines.push('removed role ' + k);
          else { const d = permDiff(L.permsFor(k, a), L.permsFor(k, c)); if (d.length) lines.push(k + ': ' + d.join(' ')); if ((a[k].label || '') !== (c[k].label || '')) lines.push(k + ' renamed to ' + c[k].label); }
        });
        if (lines.length) return L.audit(w, 'permissions.change', 'Changed role access: ' + lines.join('; '), { before: { roles: Object.keys(a) }, after: { changes: lines } });
        return;
      }
      if (id === 'options') return L.audit(w, 'settings.options', 'Changed Session Configurations (levels, formats, courts or venues)', { before: cur && { levels: cur.levels, formats: cur.formats, courts: cur.courts, venues: cur.venues }, after: out && { levels: out.levels, formats: out.formats, courts: out.courts, venues: out.venues } });
      if (id === 'booking') return L.audit(w, 'settings.booking', 'Changed the Court booking configuration (hours, rates, courts or venues)', { before: cur && { hours: cur.hours, rates: cur.rates, courts: cur.courts }, after: out && { hours: out.hours, rates: out.rates, courts: out.courts } });
    }
  } catch (e) { console.error('audit write failed:', e && e.message); }
}

async function write(req, res) {
  const w = await L.whoIs(req);
  if (w.suspended) throw forbid('Your access is paused.');
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const parts = String(b.path || '').split('/');
  const col = parts[0];
  let id = parts[1];
  const op = b.op;
  if (L.COLS.indexOf(col) < 0 || ['payments', 'refunds', 'notifications', 'locks', 'pushtokens', 'refundaccts', 'balances', 'ledger', 'balancelinks', 'audit'].indexOf(col) >= 0 || col === 'logins' && !(op === 'delete' && w.isSuper)) throw forbid();
  if (op === 'add') {
    if (col !== 'sessions' || parts.length !== 1) throw forbid();
    id = crypto.randomBytes(10).toString('hex');
  } else if (!id || !ID_RE.test(id) || parts.length !== 2) throw L.httpErr(400, 'Bad path.');
  if (b.data !== undefined && !isObj(b.data) && op !== 'delete') throw L.httpErr(400, 'Bad data.');

  const cur = op === 'add' ? null : await L.getDoc(col, id);

  if (col === 'logins') {   // only a super admin removing someone else's account
    if (id === w.uid) throw forbid();
    const gone = await L.getDoc('members', id);
    await L.one(['HDEL', L.K('logins'), id]);
    await L.bump();
    await L.audit(w, 'account.remove', (w.member.name) + ' removed the account of ' + ((gone && gone.name) || id), { subject: { id, name: gone && gone.name } });
    return res.status(200).json({ ok: true });
  }

  if (op === 'acquire') throw forbid('Bookings are made from the Book a Court page.');

  if (['set', 'update', 'delete', 'add'].indexOf(op) < 0) throw L.httpErr(400, 'Unknown operation.');
  if (op === 'delete' && !cur) return res.status(200).json({ ok: true });
  if (op !== 'add' && op !== 'set' && op !== 'delete' && !cur) throw L.httpErr(404, 'Not found.');

  let next;
  if (op === 'delete') next = null;
  else if (op === 'update') next = Object.assign({}, cur, b.data);
  else next = b.data || {};

  const out = rules[col](w, id, next, cur, op);
  if (col === 'sessions' && out !== null) {   // a session cannot take a court that is booked at that time
    const hit = B.bookingBlocking(await B.allMap('bookings'), out);
    if (hit) throw L.httpErr(409, 'That court is already booked on ' + B.dateText(hit.date) + ' at ' + B.hourText(hit.hour) + ' (booking ' + hit.ref + '). Pick another court or time.');
  }

  const wasSigns = cur && col === 'signups' ? Object.keys(cur.joined || {}) : [];
  if (out === null) await L.one(['HDEL', L.K(col), id]);
  else if (col === 'bookings' && !cur) {
    if (!(await L.one(['HSETNX', L.K(col), id, JSON.stringify(out)]))) throw L.httpErr(409, 'That hour was just booked.');
  } else await L.one(['HSET', L.K(col), id, JSON.stringify(out)]);
  if (col === 'sessions' && out !== null) {   // look again: a booking may have landed while this was being saved
    const hit = B.bookingBlocking(await B.allMap('bookings'), out);
    if (hit) {
      await L.one(cur ? ['HSET', L.K(col), id, JSON.stringify(cur)] : ['HDEL', L.K(col), id]);
      throw L.httpErr(409, 'That court was just booked at that time (booking ' + hit.ref + '). Nothing was saved.');
    }
  }
  await L.bump();
  await auditWrite(w, col, id, op, cur, out, wasSigns);
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
