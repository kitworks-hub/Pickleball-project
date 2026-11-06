/* /api/pay: everything that touches money or sends a notification. Each rule is checked here on the server.
   GET  ?cfg=1            public settings for the page (Realtime and Firebase public keys)
   GET  ?file=<path>      a payment proof or the GCash QR, after a permission check
   POST { action, ... }   book, pay, reschedule, approve, deny, cancel, settings, markread, push (and the account / audit actions) */
'use strict';
const crypto = require('crypto');
const L = require('./_lib');
const B = require('./_book');

const err = L.httpErr;
const need = (cond, status, msg) => { if (!cond) throw err(status, msg); };
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const normRef = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const newId = p => p + crypto.randomBytes(8).toString('hex');
const put = (col, id, doc) => L.one(['HSET', L.K(col), id, JSON.stringify(doc)]);
const del = (col, id) => L.one(['HDEL', L.K(col), id]);
const putNew = (col, id, doc) => L.one(['HSETNX', L.K(col), id, JSON.stringify(doc)]);
// A one-time marker: true for the first caller, false for everyone after (this is what stops double approvals and duplicates).
const lockOnce = async (key, val) => !!(await L.one(['HSETNX', L.K('locks'), key, JSON.stringify(val || 1)]));
const unlock = key => del('locks', key);
const sum = (list, f) => list.reduce((n, x) => n + (Number(f(x)) || 0), 0);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Both the reference number and the receipt are required for any GCash payment.
function gcashInput(b) {
  const gref = normRef(b.gcashRef);
  need(gref.length >= 8 && gref.length <= 30, 400, 'Enter the GCash reference number from your receipt (8 to 30 letters and numbers).');
  need(b.proof, 400, 'Upload a screenshot or photo of your GCash receipt.');
  return { gref, img: parseImage(b.proof) };
}

function parseImage(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  need(m, 400, 'Upload a photo or screenshot (JPG, PNG or WebP).');
  const buf = Buffer.from(m[2], 'base64');
  need(buf.length > 200 && buf.length <= 2.5 * 1024 * 1024, 400, 'That image is too large. Use a smaller screenshot (under 2.5 MB).');
  const ok = (m[1] === 'image/jpeg' && buf[0] === 0xFF && buf[1] === 0xD8) || (m[1] === 'image/png' && buf[0] === 0x89 && buf[1] === 0x50) || (m[1] === 'image/webp' && buf.slice(0, 4).toString() === 'RIFF');
  need(ok, 400, 'That file is not a valid image.');
  return { buf, type: m[1], ext: m[1] === 'image/jpeg' ? 'jpg' : m[1] === 'image/png' ? 'png' : 'webp' };
}

async function bookingsOf(ref) {
  const all = await B.allMap('bookings');
  return Object.keys(all).filter(id => all[id].ref === ref).map(id => Object.assign({ id }, all[id]));
}
// Checks a list of picked hours against the configuration and returns them with their server-side prices.
async function checkPicks(picks) {
  need(Array.isArray(picks) && picks.length >= 1 && picks.length <= 24, 400, 'Pick between 1 and 24 hours.');
  const cfg = await B.bookingCfg(), cols = await B.columns(cfg), now = Date.now(), seen = {}, out = [];
  for (const p of picks) {
    need(isObj(p) && /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) && Number.isInteger(p.hour), 400, 'Bad booking request.');
    const col = cols.find(c => c.name === String(p.court || '') && (c.venue || '') === String(p.venue || ''));
    need(col, 400, 'That court is not available for booking.');
    need(cfg.hours.indexOf(p.hour) >= 0, 400, 'That hour is not open for booking.');
    const price = B.priceOf(cfg, p.hour);
    need(price !== null, 400, 'No rate is set for that hour.');
    const start = B.startMs(p.date, p.hour);
    need(start > now, 400, 'That hour has already started or passed.');
    need(start < now + 91 * 86400000, 400, 'You can book up to 90 days ahead.');
    const slot = { date: p.date, venue: col.venue || '', court: col.name, hour: p.hour, price }, id = B.slotId(slot.date, slot.venue, slot.court, slot.hour);
    if (seen[id]) continue;
    seen[id] = 1; out.push(Object.assign({ id }, slot));
  }
  return out;
}
// Claims every slot or none. Two people (or a booking and a session) can never end up on the same court hour.
async function claimAll(w, slots, make) {
  const sessions = await B.allMap('sessions'), claimed = [];
  const rollback = async () => { for (const id of claimed) await del('bookings', id); };
  for (const s of slots) {
    const hit = B.sessionBlocking(sessions, s);
    if (hit) { await rollback(); throw err(409, B.dateText(s.date) + ', ' + B.hourText(s.hour) + ' on ' + s.court + ' is in use by "' + (hit.title || 'a session') + '".'); }
    const doc = make(s);
    let ok = !!(await putNew('bookings', s.id, doc));
    if (!ok) {   // taken, or only an old hold that ran out: claim it, then read back to be sure we are the one that got it
      const cur = await L.getDoc('bookings', s.id);
      if (cur && !B.occupies(cur)) { await put('bookings', s.id, doc); const back = await L.getDoc('bookings', s.id); ok = !!(back && back.by === doc.by && back.ref === doc.ref && back.at === doc.at); }
    }
    if (!ok) { await rollback(); throw err(409, B.dateText(s.date) + ', ' + B.hourText(s.hour) + ' on ' + s.court + ' was just booked by someone else. Nothing was booked.'); }
    claimed.push(s.id);
  }
  // a session may have been added while we were claiming: look again and back out if so
  const after = await B.allMap('sessions');
  for (const s of slots) {
    const hit = B.sessionBlocking(after, s);
    if (hit) { await rollback(); throw err(409, 'A session was just scheduled on ' + s.court + ' at ' + B.hourText(s.hour) + '. Nothing was booked.'); }
  }
  return claimed;
}
const slotDoc = (w, ref, status, extra) => s => Object.assign({ date: s.date, venue: s.venue, court: s.court, hour: s.hour, by: w.uid, byName: w.member.name, ref, price: s.price, paid: 0, status, at: Date.now() }, extra || {});

async function payerEmail(w, email) {
  const e = L.normEmail(email);
  if (e && L.validEmail(e) && L.emailId(e) === w.uid) { await L.rememberEmail(w.uid, e); return e; }   // only an email that really belongs to this account is kept
  return '';
}
async function submitPayment(w, b, spec) {
  need(w.can('book'), 403, 'Your role cannot book courts.');
  const { gref, img } = gcashInput(b);
  const pc = await B.payCfg();
  need(pc.gcashNumber, 503, 'Payments are not set up yet. Ask an admin to add the GCash details.');
  const payId = newId('p_');
  need(await lockOnce('gcash:' + gref, payId), 409, 'That GCash reference number was already used. Check the number on your receipt.');
  try {
    const path = 'proofs/' + payId + '.' + img.ext;
    await L.putFile(path, img.buf, img.type);
    const doc = Object.assign({ kind: spec.kind, bookingRef: spec.ref, by: w.uid, byName: w.member.name, email: await payerEmail(w, b.email), amount: spec.amount, gcashRef: gref, proofPath: path, status: 'pending_verification', submittedAt: Date.now(), slots: spec.slots }, spec.extra || {});
    await spec.apply(payId);          // claim or mark the hours first: if that fails, nothing was recorded
    await put('payments', payId, doc);
    return { payId, doc };
  } catch (e) { await unlock('gcash:' + gref); throw e; }
}
async function tellReviewers(w, payId, doc) {
  const who = (await B.usersWith('payments')).filter(u => u !== w.uid);
  await B.notify(who, { event: 'payment-submitted', refId: payId, kind: 'payment-submitted', title: 'New GCash payment to verify', body: doc.byName + ' sent ' + B.money(doc.amount) + ' for ' + doc.bookingRef + ' (GCash ref ' + doc.gcashRef + ').', data: { payId } });
}

/* ----- audit trail: what is recorded for each money / booking action (written by the server after the action succeeded) ----- */
const who = w => w.member.name;
async function auditPre(w, b) {
  try {
    if (b.action === 'cancel') return { slots: (await Promise.all((Array.isArray(b.ids) ? b.ids.slice(0, 48) : []).map(id => L.getDoc('bookings', String(id))))).filter(Boolean) };
    if (b.action === 'approve' || b.action === 'deny') return { pay: await L.getDoc('payments', String(b.id || '')) };
  } catch (e) { /* the action itself reports real problems */ }
  return {};
}
async function auditPost(w, b, pre, out) {
  try {
    const A = (action, summary, x) => L.audit(w, action, summary, x);
    switch (b.action) {
      case 'book': return A('booking.hold', who(w) + ' held ' + out.slots.length + ' court hour(s) for ' + B.money(out.total) + ' (' + out.ref + ')', { refs: { ref: out.ref }, amount: out.total, after: { slots: B.scheduleText(out.slots) } });
      case 'release': return A('booking.release', who(w) + ' released their unpaid hold ' + b.ref, { refs: { ref: String(b.ref || '') } });
      case 'pay':
        return A('payment.submit', who(w) + ' sent a GCash payment of ' + B.money(out.amount) + ' for ' + b.ref, { refs: { ref: String(b.ref), paymentId: out.paymentId }, amount: out.amount, after: { total: out.total } });
      case 'reschedule':
        if (out.moved) { await A('booking.reschedule', who(w) + ' rescheduled ' + (pre.from ? '' : '') + 'a booking hour: ' + out.from.court + ' ' + B.dateText(out.from.date) + ' ' + B.hourText(out.from.hour) + ' to ' + out.to.court + ' ' + B.dateText(out.to.date) + ' ' + B.hourText(out.to.hour), { refs: { bookingId: String(b.id) }, before: out.from, after: out.to });
          return; }
        if (out.status === 'pending_verification') return A('payment.submit', who(w) + ' sent ' + B.money(out.amount) + ' by GCash for a reschedule (' + (b.id) + ')', { refs: { paymentId: out.paymentId, bookingId: String(b.id) }, amount: out.amount });
        return;
      case 'approve': { const p = pre.pay; if (!p) return;
        await A('payment.approve', who(w) + ' approved the payment of ' + B.money(p.amount) + ' for ' + p.bookingRef + ' (' + (p.byName || '') + ')', { subject: { id: p.by, name: p.byName }, refs: { paymentId: String(b.id), ref: p.bookingRef }, amount: p.amount, before: { status: p.status }, after: { status: 'paid', booking: 'confirmed' } });
        return; }
      case 'deny': { const p = pre.pay; if (!p) return; return A('payment.deny', who(w) + ' did not approve the payment for ' + p.bookingRef + (b.reason ? ': ' + String(b.reason).slice(0, 100) : ''), { subject: { id: p.by, name: p.byName }, refs: { paymentId: String(b.id), ref: p.bookingRef }, amount: p.amount, before: { status: p.status }, after: { status: 'rejected' } }); }
      case 'cancel': {
        const groups = {};
        (pre.slots || []).forEach(s => { const k = s.by + '|' + s.ref; (groups[k] = groups[k] || []).push(s); });
        for (const k of Object.keys(groups)) { const g = groups[k], f = g[0], paid = g.reduce((n, s) => n + (Number(s.paid) || 0), 0);
          await A('booking.cancel', who(w) + ' cancelled ' + f.ref + ' (' + B.scheduleText(g) + ') of ' + f.byName + (paid ? ', paid ' + B.money(paid) : ', nothing paid'), { subject: { id: f.by, name: f.byName }, refs: { ref: f.ref }, amount: paid, before: { status: f.status || 'confirmed' }, after: { status: 'cancelled', refund: 'none (non-refundable)' } }); }
        return; }
      case 'set-level': return A('account.level', who(w) + ' set their level to ' + (out.level || 'not set'), { subject: { id: w.uid, name: who(w) }, after: { level: out.level || null } });
      case 'user-update': if (out.unchanged) return; return A('account.profile', who(w) + ' changed the name of ' + out.was + ' to ' + out.name, { subject: { id: String(b.uid), name: out.name }, before: { name: out.was }, after: { name: out.name } });
      case 'user-create': return A('account.create', who(w) + ' created the account of ' + out.name + ' (role: ' + out.role + ')', { subject: { id: out.id, name: out.name }, after: { role: out.role } });
      case 'avatar-set': return A('account.avatar', who(w) + ' changed their profile picture', { subject: { id: w.uid, name: who(w) } });
      case 'avatar-remove': return A('account.avatar', who(w) + ' removed their profile picture', { subject: { id: w.uid, name: who(w) } });
      case 'settings': return A('settings.payment', who(w) + ' changed the payment settings (' + ['gcashNumber', 'accountName', 'qr', 'removeQr'].filter(k => b[k] !== undefined && b[k] !== '' && b[k] !== false).join(', ') + ')', {});
      default: return;
    }
  } catch (e) { console.error('audit failed:', e && e.message); }
}

// While impersonating, these stay with the real owner of the account (credentials, payout details, devices) or are Super Admin only.
const NOT_WHILE_IMPERSONATING = { push: 1, 'impersonate-start': 1, 'user-create': 1, 'audit-list': 1, settings: 1 };
const actions = {
  /* ----- Super Admin: impersonate (use the site as another person). The token is short-lived, names the Super Admin, and is re-checked on every request ----- */
  async 'impersonate-start'(w, b) {
    need(w.isSuper && !w.suspended && !w.impBy, 403, 'Only the Super Admin can impersonate a user.');
    const uid = String(b.uid || '');
    need(uid && uid !== w.uid, 400, 'Choose another person to impersonate.');
    const [m, r] = await Promise.all([L.getDoc('members', uid), L.getDoc('roles', uid)]);
    need(m, 404, 'That account was not found.');
    need(!(r && (r.role === 'super_admin' || r.owner)), 403, 'A Super Admin account cannot be impersonated.');
    await L.throttle('impersonate:' + w.uid, 30, 3600);
    await L.audit(w, 'impersonation.start', w.member.name + ' (Super Admin) started impersonating ' + m.name, { subject: { id: uid, name: m.name }, after: { role: (r && r.role) || 'player', expiresInHours: 2 } });
    return { ok: true, token: L.signImpToken(w.uid, uid), id: uid, name: m.name, role: (r && r.role) || 'player' };
  },
  async 'impersonate-end'(w) {
    need(w.impBy, 400, 'You are not impersonating anyone.');
    await L.audit(w, 'impersonation.end', w.impBy.name + ' (Super Admin) stopped impersonating ' + w.member.name, { subject: { id: w.uid, name: w.member.name } });
    return { ok: true };
  },

  /* ----- Super Admin: Edit user. The name is changed here (people can only change their own name through the page); roles use the normal role rules ----- */
  async 'user-detail'(w, b) {
    need(w.isSuper && !w.suspended, 403, 'Only the Super Admin can see account details.');
    const uid = String(b.uid || ''), m = await L.getDoc('members', uid);
    need(m, 404, 'That account was not found.');
    const e = await L.getDoc('emails', uid);
    return { ok: true, name: m.name, email: (e && e.email) || null };
  },
  async 'user-update'(w, b) {
    need(w.isSuper && !w.suspended && !w.impBy, 403, 'Only the Super Admin can edit user details.');
    const uid = String(b.uid || ''), name = String(b.name || '').trim().slice(0, 80), m = await L.getDoc('members', uid);
    need(m, 404, 'That account was not found.');
    need(name.length >= 2, 400, 'Enter the full name.');
    if (name === m.name) return { ok: true, name, unchanged: true };
    await put('members', uid, Object.assign({}, m, { name }));
    await L.bump();
    return { ok: true, name, was: m.name };
  },

  /* ----- Super Admin: create an account for someone (the same account a sign-up would make, with a role chosen here) ----- */
  async 'user-create'(w, b) {
    need(w.isSuper && !w.suspended, 403, 'Only the Super Admin can create users.');
    const name = String(b.name || '').trim().slice(0, 80), email = L.normEmail(b.email), pw = typeof b.password === 'string' ? b.password : '', role = String(b.role || 'player');
    need(name.length >= 2, 400, 'Enter the full name.');
    need(L.validEmail(email), 400, 'Enter a valid email address.');
    need(pw.length >= 8, 400, 'Use at least 8 characters for the password.');
    need(pw.length <= 200, 400, 'That password is too long.');
    need(['super_admin', 'admin', 'staff', 'player'].indexOf(role) >= 0 || (w.defs && w.defs[role]), 400, 'Choose a role from the list.');
    await L.throttle('usercreate:' + w.uid, 40, 3600);
    const id = L.emailId(email), now = Date.now();
    need(await putNew('members', id, { name, createdAt: now, pwSetAt: now }), 409, 'An account with that email already exists.');
    try {
      await put('logins', id, await L.makeCred(email, pw));
      await L.rememberEmail(id, email);
      if (role !== 'player') await put('roles', id, { role, by: w.uid, at: now });
    } catch (e) { await del('members', id); await del('logins', id); await del('roles', id); throw e; }   // never leave half an account
    await L.bump();
    return { ok: true, id, name, role };
  },

  /* ----- Super Admin: the Audit Trail (read only: nothing here, or anywhere, edits or deletes a record) ----- */
  async 'audit-list'(w, b) {
    need(w.isSuper && !w.suspended, 403, 'Only the Super Admin can open the Audit Trail.');
    const all = await B.allMap('audit'), q = String(b.q || '').trim().toLowerCase(), area = String(b.area || ''), actor = String(b.actor || '').trim().toLowerCase();
    const from = Number(b.from) || 0, to = Number(b.to) || 0, before = String(b.before || ''), limit = Math.min(200, Math.max(10, Number(b.limit) || 60));
    const rows = Object.keys(all).sort().reverse().map(id => Object.assign({ id }, all[id]));
    const areas = Array.from(new Set(rows.map(r => r.area))).sort(), tampered = rows.filter(r => r.sig !== L.auditSig(r)).length;
    const act = String(b.kind || '');
    let list = rows.filter(r => (!area || r.area === area) && (!act || r.action === act) &&(!from || r.at >= from) && (!to || r.at <= to)
      && (!actor || [r.actor && r.actor.name, r.actor && r.actor.id, r.actor && r.actor.role].join(' ').toLowerCase().indexOf(actor) >= 0)
      && (!q || [r.summary, r.action, r.actor && r.actor.name, r.subject && r.subject.name, JSON.stringify(r.refs || {})].join(' ').toLowerCase().indexOf(q) >= 0));
    const total = list.length;
    if (before) list = list.filter(r => r.id < before);
    const page = list.slice(0, limit);
    return { items: page.map(r => { const o = Object.assign({}, r, { verified: r.sig === L.auditSig(r) }); delete o.sig; return o; }), total, hasMore: list.length > page.length, areas, tampered, all: rows.length };
  },

  /* ----- pick hours and hold them while paying ----- */
  async book(w, b) {
    need(w.can('book'), 403, 'Your role cannot book courts.');
    const slots = await checkPicks(b.picks), all = await B.allMap('bookings');
    const held = Object.keys(all).filter(id => all[id].by === w.uid && all[id].status === 'hold' && B.occupies(all[id])).length;
    need(held + slots.length <= 12, 400, 'You already have hours waiting for payment. Finish paying for them, or wait a few minutes for them to be released.');
    const ref = B.refCode(), holdUntil = Date.now() + B.HOLD_MS;
    await claimAll(w, slots, slotDoc(w, ref, 'hold', { holdUntil }));
    await L.bump();
    return { ref, holdUntil, total: sum(slots, s => s.price), slots: slots.map(s => ({ date: s.date, venue: s.venue, court: s.court, hour: s.hour, price: s.price })) };
  },

  // Give the hours back (for example when the player closes the payment window). Only an unpaid hold can be released this way.
  async release(w, b) {
    const mine = (await bookingsOf(String(b.ref || ''))).filter(x => x.by === w.uid && x.status === 'hold');
    for (const x of mine) await del('bookings', x.id);
    if (mine.length) await L.bump();
    return { ok: true };
  },

  /* ----- paying for a new booking: GCash (reference number and receipt are both required) ----- */
  async pay(w, b) {
    const ref = String(b.ref || '');
    need(await lockOnce('payref:' + ref, w.uid), 409, 'This booking was already submitted for payment.');
    try {
      const slots = (await bookingsOf(ref)).filter(x => x.by === w.uid);
      need(slots.length, 404, 'We could not find that booking.');
      need(slots.every(x => x.status === 'hold'), 409, 'This booking was already submitted for payment verification.');
      need(slots.every(x => B.occupies(x)), 409, 'Your hold on these hours ran out. Please pick the hours again.');
      const total = sum(slots, x => x.price);
      const lines = slots.map(x => ({ date: x.date, venue: x.venue, court: x.court, hour: x.hour, price: x.price }));
      const toPending = payId => async () => { for (const x of slots) { const nx = Object.assign({}, x, { status: 'pending', payId }); delete nx.id; delete nx.holdUntil; await put('bookings', x.id, nx); } };
      const { payId, doc } = await submitPayment(w, b, { kind: 'booking', ref, amount: total, slots: lines, extra: { total }, apply: async id => toPending(id)() });
      await L.bump();
      await tellReviewers(w, payId, doc);
      return { ok: true, paymentId: payId, status: 'pending_verification', amount: total, total };
    } catch (e) { await unlock('payref:' + ref); throw e; }
  },

  /* ----- move one hour: free when the price is the same or lower, GCash top-up when it is higher ----- */
  async reschedule(w, b) {
    const from = await L.getDoc('bookings', String(b.id || ''));
    need(from && from.by, 404, 'That booking no longer exists.');
    const owner = from.by === w.uid;
    need(owner || w.can('managebookings'), 403, 'Only the player or a booking manager can reschedule this.');
    need(!from.status || from.status === 'confirmed', 409, from.status === 'pending' ? 'This booking is waiting for payment verification.' : 'Only a confirmed booking can be rescheduled.');
    need(B.startMs(from.date, from.hour) > Date.now(), 400, 'This hour has already started.');
    const pays = await B.allMap('payments');
    need(!Object.keys(pays).some(k => pays[k].status === 'pending_verification' && pays[k].move && pays[k].move.from === b.id), 409, 'A reschedule for this hour is already waiting for payment verification.');
    const [to] = await checkPicks([b.to]);
    need(to.id !== b.id, 400, 'Pick a different date, court or hour.');
    const paidSoFar = Number(from.paid) || 0, diff = to.price - paidSoFar;
    const base = { by: from.by, byName: from.byName, ref: from.ref, price: to.price, at: Date.now() };
    if (diff <= 0) {   // no extra money needed: move straight away (claim the new hour first, then free the old one). Nothing is paid back if the new hour is cheaper.
      await claimAll({ uid: from.by, member: { name: from.byName } }, [to], s => Object.assign({ date: s.date, venue: s.venue, court: s.court, hour: s.hour, paid: paidSoFar, status: 'confirmed' }, base));
      await del('bookings', b.id);
      await L.bump();
      await B.notify([from.by], { event: 'rescheduled', refId: from.ref + '.' + to.id, kind: 'rescheduled', title: 'Booking rescheduled', body: 'Your booking ' + from.ref + ' is now ' + B.scheduleText([to]) + '.', data: { ref: from.ref, slots: [{ venue: to.venue || '', court: to.court, date: to.date, hour: to.hour }] } });
      return { moved: true, amount: 0, from: { date: from.date, venue: from.venue, court: from.court, hour: from.hour, paid: paidSoFar }, to: { date: to.date, venue: to.venue, court: to.court, hour: to.hour, price: to.price } };
    }
    need(owner, 403, 'This move costs more than was paid. Ask the player to reschedule from their own account so they can pay the difference.');
    if (!b.proof) return { needPayment: true, amount: diff, newPrice: to.price, paid: paidSoFar };   // nothing changes yet: the page now collects the difference
    const { payId, doc } = await submitPayment(w, b, {
      kind: 'reschedule', ref: from.ref, amount: diff,
      slots: [{ date: to.date, venue: to.venue, court: to.court, hour: to.hour, price: to.price }],
      extra: { move: { from: b.id, to: { id: to.id, date: to.date, venue: to.venue, court: to.court, hour: to.hour } }, fromSlot: { date: from.date, venue: from.venue, court: from.court, hour: from.hour } },
      apply: async payId => { await claimAll(w, [to], s => Object.assign({ date: s.date, venue: s.venue, court: s.court, hour: s.hour, paid: 0, status: 'resched', payId, moveFrom: b.id }, base)); }
    });
    await L.bump();
    await tellReviewers(w, payId, doc);
    return { ok: true, paymentId: payId, status: 'pending_verification', amount: diff };
  },

  /* ----- staff: approve or deny a GCash payment ----- */
  async approve(w, b) {
    need(w.can('payments'), 403, 'Your role cannot verify payments.');
    const id = String(b.id || ''), pay = await L.getDoc('payments', id);
    need(pay, 404, 'Payment not found.');
    need(pay.status === 'pending_verification', 409, 'This payment was already reviewed.');
    need(!(Number(pay.balanceUsed) > 0), 409, 'This payment was partly covered by a balance that no longer exists. Deny it so the player can pay the full amount.');
    need(await lockOnce('ev:approve:' + id, w.uid), 409, 'This payment is already being approved.');
    let slots, committed = false;
    try {
    if (pay.kind === 'reschedule') {
      const to = await L.getDoc('bookings', pay.move.to.id), from = await L.getDoc('bookings', pay.move.from);
      need(to && to.status === 'resched' && to.payId === id, 409, 'The new hour is no longer held for this payment.');
      need(from, 409, 'The original booking no longer exists.');
      await put('bookings', pay.move.to.id, Object.assign({}, to, { status: 'confirmed', paid: (Number(from.paid) || 0) + pay.amount, payId: id, moveFrom: undefined }));
      await del('bookings', pay.move.from);
      slots = [Object.assign({}, to)];
    } else {
      const mine = (await bookingsOf(pay.bookingRef)).filter(x => x.status === 'pending' && x.payId === id);
      need(mine.length, 409, 'The hours for this payment are no longer held.');
      for (const x of mine) { const nx = Object.assign({}, x, { status: 'confirmed', paid: x.price }); delete nx.id; await put('bookings', x.id, nx); }
      slots = mine;
    }
    await put('payments', id, Object.assign({}, pay, { status: 'paid', reviewedBy: w.uid, reviewedByName: w.member.name, reviewedAt: Date.now() }));
    committed = true;
    } catch (e) { if (!committed) await unlock('ev:approve:' + id); throw e; }
    await L.bump();
    // told once, only now that the payment is verified
    const first = slots[0], when = B.scheduleText(slots);
    const resched = pay.kind === 'reschedule';
    const data = { ref: pay.bookingRef, venue: first.venue || '', court: first.court, date: first.date, schedule: when, slots: slots.map(s => ({ venue: s.venue || '', court: s.court, date: s.date, hour: s.hour })),
      amount: resched ? pay.amount : (Number(pay.total) || pay.amount), what: resched ? 'reschedule' : 'booking', paidWith: 'GCash', status: 'Confirmed' };
    await B.notify([pay.by], {
      event: 'payment-approved', refId: id, kind: 'payment-approved', data,
      title: pay.kind === 'reschedule' ? 'Reschedule confirmed ✓' : 'Payment approved ✓',
      body: 'Please go to ' + (first.venue || 'the venue') + ': ' + when + '. Your reference number is ' + pay.bookingRef + '. Show it to the venue staff before using the court.'
    });
    return { ok: true };
  },

  async deny(w, b) {
    need(w.can('payments'), 403, 'Your role cannot verify payments.');
    const id = String(b.id || ''), pay = await L.getDoc('payments', id), reason = String(b.reason || '').trim().slice(0, 200);
    need(pay, 404, 'Payment not found.');
    need(pay.status === 'pending_verification', 409, 'This payment was already reviewed.');
    need(await lockOnce('ev:deny:' + id, w.uid), 409, 'This payment is already being reviewed.');
    if (pay.kind === 'reschedule') { const to = await L.getDoc('bookings', pay.move.to.id); if (to && to.payId === id) await del('bookings', pay.move.to.id); }   // the original booking was never touched
    else for (const x of (await bookingsOf(pay.bookingRef)).filter(x => x.status === 'pending' && x.payId === id)) {
      const nx = Object.assign({}, x, { status: 'hold', holdUntil: Date.now() + B.RETRY_HOLD_MS }); delete nx.id; delete nx.payId; await put('bookings', x.id, nx);   // kept for a while so a corrected receipt can be sent
    }
    await unlock('gcash:' + pay.gcashRef);
    if (pay.kind === 'booking') await unlock('payref:' + pay.bookingRef);
    await put('payments', id, Object.assign({}, pay, { status: 'rejected', reason, reviewedBy: w.uid, reviewedByName: w.member.name, reviewedAt: Date.now() }));
    await L.bump();
    await B.notify([pay.by], { event: 'payment-rejected', refId: id, kind: 'payment-rejected', data: { ref: pay.bookingRef, reason }, title: 'Payment not approved', body: 'We could not verify your GCash payment for ' + pay.bookingRef + '.' + (reason ? ' Reason: ' + reason : '') + (pay.kind === 'reschedule' ? ' Your original booking is unchanged.' : ' Your hours are held for 30 minutes so you can send a corrected receipt.') });
    return { ok: true };
  },

  /* ----- cancelling. Staff can cancel anyone's booking; a player can cancel their OWN confirmed booking until its hour ends.
         A cancelled booking is non-refundable: the hours are released, nothing is refunded and nothing is credited. ----- */
  async cancel(w, b) {
    const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 48) : [];
    need(ids.length, 400, 'Nothing to cancel.');
    const slots = [];
    for (const id of ids) { const s = await L.getDoc('bookings', id); if (s && s.by) slots.push(Object.assign({ id }, s)); }
    need(slots.length, 404, 'That booking no longer exists.');
    const staff = w.can('managebookings');
    need(staff || slots.every(s => s.by === w.uid), 403, 'You can only cancel your own bookings.');
    const pays = await B.allMap('payments');
    for (const s of slots) {
      need(s.status !== 'pending' && s.status !== 'resched', 409, 'This booking is waiting for payment verification. It can be cancelled once the payment is approved or denied.');
      need(!Object.keys(pays).some(k => pays[k].status === 'pending_verification' && pays[k].move && pays[k].move.from === s.id), 409, 'A reschedule for this hour is waiting for payment verification. Cancel after it is approved or denied.');
      need(!L.bookingEnded(s), 409, 'This hour has already ended, so it can no longer be cancelled.');
      if (!staff) need(s.status !== 'hold', 409, 'This booking has not been paid yet. Close its payment window to release the hours.');
    }
    const batch = newId('cb_'), groups = {};
    for (const s of slots) { await del('bookings', s.id); (groups[s.by + '|' + s.ref] = groups[s.by + '|' + s.ref] || []).push(s); }
    for (const key of Object.keys(groups)) {
      const g = groups[key], first = g[0], own = first.by === w.uid;   // the player cancelled it themselves: they already see the confirmation, so no pop-up or push for it
      await B.notify([first.by], { event: 'booking-cancelled', refId: batch + '.' + first.ref, kind: 'booking-cancelled', read: own, data: { ref: first.ref, batch, venue: first.venue || '', court: Array.from(new Set(g.map(x => x.court))).join(', '), schedule: B.scheduleText(g), status: 'Cancelled' }, title: 'Booking cancelled', body: B.scheduleText(g) + ' was cancelled. Cancelled bookings are non-refundable.' });
    }
    await L.bump();
    return { ok: true, cancelled: slots.length };
  },

  async 'set-level'(w, b) {
    const level = String(b.level == null ? '' : b.level).trim(), cur = (await L.getDoc('members', w.uid)) || {};
    if (level) {
      const levels = B.levelsOf(await L.getDoc('config', 'options'));
      need(levels.indexOf(level) >= 0, 400, 'That level is not offered. Pick one of the levels in the list.');
    }
    const next = Object.assign({}, cur); if (level) next.level = level; else delete next.level;
    await put('members', w.uid, next);
    await L.bump();
    return { ok: true, level };
  },

  /* ----- the player: profile picture (private storage, shown to signed-in people only) ----- */
  async 'avatar-set'(w, b) {
    const img = parseImage(b.image);
    need(img.buf.length <= 600 * 1024, 400, 'That picture is too large. Use a smaller one.');
    const cur = (await L.getDoc('members', w.uid)) || {}, path = 'avatars/' + w.uid + '-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.' + img.ext;
    await L.putFile(path, img.buf, img.type);
    await put('members', w.uid, Object.assign({}, cur, { avatar: path, avatarAt: Date.now() }));
    if (cur.avatar && cur.avatar !== path) await L.delFile(cur.avatar);
    await L.bump();
    return { ok: true, avatar: path };
  },
  async 'avatar-remove'(w) {
    const cur = (await L.getDoc('members', w.uid)) || {};
    if (!cur.avatar) return { ok: true };
    const next = Object.assign({}, cur); delete next.avatar; delete next.avatarAt;
    await put('members', w.uid, next);
    await L.delFile(cur.avatar);
    await L.bump();
    return { ok: true };
  },





  /* ----- admin: GCash details and QR code ----- */
  async settings(w, b) {
    need(w.can('paysettings'), 403, 'Your role cannot change payment settings.');
    const cur = await L.getDoc('config', 'payment') || {}, next = Object.assign({}, cur);
    if (b.gcashNumber !== undefined) {
      const n = String(b.gcashNumber).replace(/[\s-]/g, '');
      need(/^(\+?63|0)9\d{9}$/.test(n), 400, 'Enter a valid GCash number, like 09171234567.');
      next.gcashNumber = n;
    }
    if (b.accountName !== undefined) {
      const a = String(b.accountName).trim();
      need(a.length >= 2 && a.length <= 60, 400, 'Enter the account name shown in GCash.');
      next.accountName = a;
    }
    if (b.qr) { const img = parseImage(b.qr), path = 'qr/qr-' + Date.now() + '.' + img.ext; await L.putFile(path, img.buf, img.type); next.qrPath = path; }
    else if (b.removeQr) next.qrPath = '';
    next.updatedBy = w.uid; next.updatedAt = Date.now();
    await put('config', 'payment', next);
    await L.bump();
    return { ok: true };
  },

  /* ----- people: read receipts and phone push devices ----- */
  async markread(w, b) {
    const all = await B.allMap('notifications'), ids = b.all ? Object.keys(all) : (Array.isArray(b.ids) ? b.ids.map(String) : []);
    let n = 0;
    for (const id of ids) {
      const x = all[id];
      if (!x || x.to !== w.uid || x.read) continue;
      await put('notifications', id, Object.assign({}, x, { read: true, readAt: Date.now() })); n++;
    }
    // tidy: read notifications older than two weeks
    for (const id of Object.keys(all)) if (all[id].to === w.uid && all[id].read && Date.now() - all[id].at > 14 * 86400000) await del('notifications', id);
    if (n) await L.bump();
    return { ok: true, marked: n };
  },
  async push(w, b) {
    await L.throttle('push:' + w.uid, 30, 3600);
    const doc = (await L.getDoc('pushtokens', w.uid)) || { tokens: [] }, token = String(b.token || '');
    if (b.op === 'unregister') {
      doc.tokens = token ? doc.tokens.filter(x => x.t !== token) : [];
    } else {
      need(b.op === 'register' && token.length >= 20 && token.length <= 4096, 400, 'Bad device token.');
      doc.tokens = doc.tokens.filter(x => x.t !== token).concat([{ t: token, at: Date.now(), ua: String(b.ua || '').slice(0, 120) }]).slice(-5);
    }
    await put('pushtokens', w.uid, doc);
    return { ok: true, devices: doc.tokens.length };
  }
};

// This key is sent to every visitor, so only something that really is a Supabase publishable (or legacy anon) key may ever go out.
// Anything else, above all a secret key pasted in by mistake, is refused.
function safePublicKey(k) {
  k = String(k || '').trim();
  if (/^sb_publishable_[A-Za-z0-9_\-]+$/.test(k)) return k;
  if (/^eyJ[\w\-]+\.[\w\-]+\.[\w\-]+$/.test(k)) {   // a legacy JWT key: only the "anon" role is public
    try { return JSON.parse(Buffer.from(k.split('.')[1], 'base64url').toString('utf8')).role === 'anon' ? k : ''; } catch (e) { return ''; }
  }
  return '';
}
function publicConfig() {
  let fb = null;
  try { fb = process.env.FIREBASE_WEB_CONFIG ? JSON.parse(process.env.FIREBASE_WEB_CONFIG) : null; } catch (e) { fb = null; }
  const pk = safePublicKey(process.env.SUPABASE_PUBLISHABLE_KEY);
  return {
    realtime: process.env.SUPABASE_URL && pk ? { url: process.env.SUPABASE_URL, key: pk, topic: 'mpc-sync' } : null,
    firebase: fb && process.env.FIREBASE_VAPID_KEY ? { config: fb, vapidKey: process.env.FIREBASE_VAPID_KEY } : null
  };
}

async function sendFile(req, res) {
  const w = await L.whoIs(req), path = String(req.query.file || '');
  need(/^(qr|proofs|avatars)\/[\w.\-]+$/.test(path), 400, 'Bad file.');   // avatars: any signed-in person
  if (path.startsWith('proofs/')) {
    const pay = await L.getDoc('payments', path.slice(7).replace(/\.\w+$/, ''));
    need(pay && (pay.by === w.uid || w.can('payments')), 403, 'You cannot view this file.');
  }
  const f = await L.getFile(path);
  need(f, 404, 'File not found.');
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(f.buffer);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      if (req.query && req.query.cfg) return res.status(200).json(publicConfig());
      if (req.query && req.query.file) return await sendFile(req, res);
      throw err(400, 'Bad request.');
    }
    need(req.method === 'POST', 405, 'Use GET or POST.');
    const w = await L.whoIs(req), b = isObj(req.body) ? req.body : {};
    need(!w.suspended || b.action === 'impersonate-end', 403, 'Your access is paused.');
    const fn = actions[b.action];
    need(fn, 400, 'Unknown action.');
    need(!(w.impBy && NOT_WHILE_IMPERSONATING[b.action]), 403, 'That is not available while you are impersonating someone.');
    if (w.impBy && b.action === 'markread') return res.status(200).json({ ok: true, skipped: true });   // looking around must not mark their notifications as read
    await L.throttle('pay:' + w.uid, 120, 600);
    const pre = await auditPre(w, b), out = await fn(w, b);
    if (b.action.indexOf('impersonate-') !== 0) await auditPost(w, b, pre, out);
    res.status(200).json(out);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('pay error:', e && e.message);
    res.status(status).json({ error: status >= 500 && !e.status ? 'Something went wrong.' : e.message });
  }
};
