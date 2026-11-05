/* /api/pay: everything that touches money or sends a notification. Each rule is checked here on the server.
   GET  ?cfg=1            public settings for the page (Realtime and Firebase public keys)
   GET  ?file=<path>      a payment proof or the GCash QR, after a permission check
   POST { action, ... }   book, pay, reschedule, approve, deny, cancel, refund-approve, refund-complete, refund-deny,
                          settings, markread, push */
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
// A one-time marker: true for the first caller, false for everyone after (this is what stops double approvals, refunds and duplicates).
const lockOnce = async (key, val) => !!(await L.one(['HSETNX', L.K('locks'), key, JSON.stringify(val || 1)]));
const unlock = key => del('locks', key);
const sum = (list, f) => list.reduce((n, x) => n + (Number(f(x)) || 0), 0);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NOT_CHOSEN = 'The player has not chosen how to receive this refund yet, so it cannot be processed. Use "Fix and remind" to ask them, or ask them to choose from the Refundable Balance box.';

/* ----- refund balance: one person's balance is changed by one request at a time ----- */
async function withBalance(uid, fn) {
  const key = 'bal:' + uid;
  for (let i = 0; i < 50; i++) {
    if (await lockOnce(key, { t: Date.now() })) { try { return await fn(); } finally { await unlock(key); } }
    const cur = await L.getDoc('locks', key);
    if (cur && Date.now() - Number(cur.t || 0) > 15000) await unlock(key);   // a crashed request left it behind
    await sleep(60 + Math.random() * 80);
  }
  throw err(503, 'Your balance is being updated. Please try again in a moment.');
}
const getBal = async uid => Object.assign({ amount: 0, reserved: 0 }, await L.getDoc('balances', uid));
const putBal = (uid, bal) => put('balances', uid, Object.assign({}, bal, { updatedAt: Date.now() }));
const ledger = (uid, type, amount, after, extra) => put('ledger', newId('lg_'), Object.assign({ uid, type, amount, balanceAfter: after, at: Date.now() }, extra || {}));
// Both the reference number and the receipt are required for any GCash payment.
function gcashInput(b) {
  const gref = normRef(b.gcashRef);
  need(gref.length >= 8 && gref.length <= 30, 400, 'Enter the GCash reference number from your receipt (8 to 30 letters and numbers).');
  need(b.proof, 400, 'Upload a screenshot or photo of your GCash receipt.');
  return { gref, img: parseImage(b.proof) };
}
// Adds a refund to the player's Refundable Balance, once: the ledger entry credit_<refundId> is the one-time marker.
async function creditRefundToBalance(id, r, uid, actor) {
  need(await lockOnce('ev:rfchoose:' + id, uid), 409, 'You already chose how to receive this refund.');
  let newBalance = 0;
  try {
    await withBalance(uid, async () => {
      const bal = await getBal(uid);
      newBalance = bal.amount + r.refundable;
      if (!(await putNew('ledger', 'credit_' + id, { uid, type: 'refund-credit', amount: r.refundable, balanceAfter: newBalance, refundId: id, ref: r.bookingRef, at: Date.now() }))) throw err(409, 'This refund was already credited.');   // one credit per refund, ever
      await putBal(uid, Object.assign({}, bal, { amount: newBalance }));
    });
  } catch (e) { await unlock('ev:rfchoose:' + id); throw e; }
  await put('refunds', id, Object.assign({}, r, { status: 'refunded', method: 'balance', actualAmount: r.refundable, refundRef: 'REFUND BALANCE', chosenAt: Date.now(), refundedAt: Date.now(), refundedByName: 'Refund balance' }));
  await L.bump();
  await L.audit(actor || null, 'balance.credit', B.money(r.refundable) + ' added to ' + (r.byName || 'a player') + "'s Refundable Balance (refund of " + r.bookingRef + ')', { subject: { id: uid, name: r.byName }, refs: { refundId: id, ref: r.bookingRef }, amount: r.refundable, before: { balance: Math.round((newBalance - r.refundable) * 100) / 100 }, after: { balance: newBalance } });
  await B.notify([uid], { event: 'refund-done', refId: id, kind: 'refund-done', read: true, data: { ref: r.bookingRef, amount: r.refundable, method: 'balance', balance: newBalance }, title: 'Refund added to your balance', body: B.money(r.refundable) + ' from booking ' + r.bookingRef + ' was added to your refund balance.' });
  return newBalance;
}
async function tellBookingConfirmed(uid, name, payId, ref, slots, total, how) {
  const first = slots[0], when = B.scheduleText(slots), data = { ref, venue: first.venue || '', court: first.court, date: first.date, schedule: when, slots: slots.map(s => ({ venue: s.venue || '', court: s.court, date: s.date, hour: s.hour })), amount: total, paidWith: 'Refund Balance', status: 'Confirmed' };
  await B.notify([uid], { event: 'payment-approved', refId: payId, kind: 'payment-approved', data, title: 'Booking confirmed ✓', body: 'Please go to ' + (first.venue || 'the venue') + ': ' + when + '. Your reference number is ' + ref + '. Show it to the venue staff before using the court.' });
  const staff = (await B.venueStaff(first.venue)).filter(u => u !== uid);
  await B.notify(staff, { event: 'booking-confirmed', refId: payId, kind: 'booking-confirmed', data, title: 'New confirmed booking', body: name + ' · ' + ref + ' · ' + when + ' · Payment: ' + how + ' ' + B.money(total) + '.' });
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
  return e && L.validEmail(e) && L.emailId(e) === w.uid ? e : '';   // only an email that really belongs to this account is kept
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
    if (b.action.indexOf('refund-') === 0 && b.id) return { refund: await L.getDoc('refunds', String(b.id)) };
    if (b.action === 'balance-link') { const [f, t] = await Promise.all([L.getDoc('members', String(b.from || '')), L.getDoc('members', String(b.to || ''))]); return { from: f, to: t }; }
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
        if (out.status === 'paid') { await A('payment.balance', who(w) + ' paid ' + B.money(out.total) + ' for ' + b.ref + ' with Refund Balance', { refs: { ref: String(b.ref), paymentId: out.paymentId }, amount: out.total }); return A('balance.use', B.money(out.total) + ' of ' + who(w) + "'s Refundable Balance used for " + b.ref, { subject: { id: w.uid, name: who(w) }, refs: { ref: String(b.ref), paymentId: out.paymentId }, amount: -out.total }); }
        return A('payment.submit', who(w) + ' sent a GCash payment of ' + B.money(out.amount) + ' for ' + b.ref + (out.balanceUsed ? ' (plus ' + B.money(out.balanceUsed) + ' Refund Balance set aside)' : ''), { refs: { ref: String(b.ref), paymentId: out.paymentId }, amount: out.amount, after: { total: out.total, balanceUsed: out.balanceUsed } });
      case 'reschedule':
        if (out.moved) { await A('booking.reschedule', who(w) + ' rescheduled ' + (pre.from ? '' : '') + 'a booking hour: ' + out.from.court + ' ' + B.dateText(out.from.date) + ' ' + B.hourText(out.from.hour) + ' to ' + out.to.court + ' ' + B.dateText(out.to.date) + ' ' + B.hourText(out.to.hour) + (out.credited ? ', difference ' + B.money(out.credited) + ' credited to balance' : ''), { refs: { bookingId: String(b.id) }, before: out.from, after: out.to, amount: out.credited || 0 });
          if (out.credited) await A('balance.credit', B.money(out.credited) + " price difference added to the Refundable Balance after a reschedule", { refs: { bookingId: String(b.id) }, amount: out.credited });
          return; }
        if (out.status === 'pending_verification') return A('payment.submit', who(w) + ' sent ' + B.money(out.amount) + ' by GCash for a reschedule (' + (b.id) + ')', { refs: { paymentId: out.paymentId, bookingId: String(b.id) }, amount: out.amount });
        return;
      case 'approve': { const p = pre.pay; if (!p) return;
        await A('payment.approve', who(w) + ' approved the payment of ' + B.money(p.amount) + ' for ' + p.bookingRef + ' (' + (p.byName || '') + ')', { subject: { id: p.by, name: p.byName }, refs: { paymentId: String(b.id), ref: p.bookingRef }, amount: p.amount, before: { status: p.status }, after: { status: 'paid', booking: 'confirmed' } });
        if (p.kind === 'booking' && Number(p.balanceUsed) > 0) await A('balance.use', B.money(p.balanceUsed) + " of Refundable Balance deducted for " + p.bookingRef, { subject: { id: p.by, name: p.byName }, refs: { paymentId: String(b.id), ref: p.bookingRef }, amount: -p.balanceUsed });
        return; }
      case 'deny': { const p = pre.pay; if (!p) return; return A('payment.deny', who(w) + ' did not approve the payment for ' + p.bookingRef + (b.reason ? ': ' + String(b.reason).slice(0, 100) : ''), { subject: { id: p.by, name: p.byName }, refs: { paymentId: String(b.id), ref: p.bookingRef }, amount: p.amount, before: { status: p.status }, after: { status: 'rejected' } }); }
      case 'cancel': {
        const groups = {};
        (pre.slots || []).forEach(s => { const k = s.by + '|' + s.ref; (groups[k] = groups[k] || []).push(s); });
        for (const k of Object.keys(groups)) { const g = groups[k], f = g[0], paid = g.reduce((n, s) => n + (Number(s.paid) || 0), 0);
          await A('booking.cancel', who(w) + ' cancelled ' + f.ref + ' (' + B.scheduleText(g) + ') of ' + f.byName + (paid ? ', paid ' + B.money(paid) : ', nothing paid'), { subject: { id: f.by, name: f.byName }, refs: { ref: f.ref, refundIds: out.refunds || [] }, amount: paid, before: { status: f.status || 'confirmed' }, after: { credited: out.credited || 0, refundOpen: out.chooseAmount || 0 } }); }
        return; }
      case 'refund-choose': return A('refund.choose', who(w) + ' chose ' + (b.method === 'gcash' ? 'a GCash refund' : 'to keep the refund as balance') + ' for ' + (pre.refund ? pre.refund.bookingRef : b.id), { refs: { refundId: String(b.id) }, amount: pre.refund ? pre.refund.refundable : null });
      case 'refund-approve': return A('refund.approve', who(w) + ' approved a refund for ' + (pre.refund ? pre.refund.bookingRef : b.id), { subject: pre.refund && { id: pre.refund.by, name: pre.refund.byName }, refs: { refundId: String(b.id) } });
      case 'refund-complete': return A('refund.complete', who(w) + ' recorded a GCash refund of ' + B.money(Math.round(Number(b.amount))) + ' for ' + (pre.refund ? pre.refund.bookingRef : b.id), { subject: pre.refund && { id: pre.refund.by, name: pre.refund.byName }, refs: { refundId: String(b.id), gcashRef: normRef(b.gcashRef) }, amount: Math.round(Number(b.amount)) });
      case 'refund-deny': return A('refund.deny', who(w) + ' denied the refund for ' + (pre.refund ? pre.refund.bookingRef : b.id) + (b.reason ? ': ' + String(b.reason).slice(0, 100) : ''), { subject: pre.refund && { id: pre.refund.by, name: pre.refund.byName }, refs: { refundId: String(b.id) } });
      case 'refund-repair': return A('refund.repair', who(w) + ' used Fix and remind on the refund for ' + (pre.refund ? pre.refund.bookingRef : b.id) + (out.fixed && out.fixed.length ? ' (' + out.fixed.join('; ') + ')' : ''), { subject: pre.refund && { id: pre.refund.by, name: pre.refund.byName }, refs: { refundId: String(b.id) } });
      case 'refund-account': return A('account.gcash', who(w) + ' saved their GCash refund details', { subject: { id: w.uid, name: who(w) } });
      case 'set-level': return A('account.level', who(w) + ' set their level to ' + (out.level || 'not set'), { subject: { id: w.uid, name: who(w) }, after: { level: out.level || null } });
      case 'avatar-set': return A('account.avatar', who(w) + ' changed their profile picture', { subject: { id: w.uid, name: who(w) } });
      case 'avatar-remove': return A('account.avatar', who(w) + ' removed their profile picture', { subject: { id: w.uid, name: who(w) } });
      case 'balance-link': return A('balance.link', who(w) + ' moved ' + B.money(out.amount) + ' of Refundable Balance from ' + ((pre.from && pre.from.name) || b.from) + ' to ' + ((pre.to && pre.to.name) || b.to), { subject: { id: String(b.from), name: pre.from && pre.from.name }, refs: { linkId: out.id, toId: String(b.to), toName: pre.to && pre.to.name }, amount: out.amount, before: { fromBalance: Math.round((out.fromAfter + out.amount) * 100) / 100 }, after: { fromBalance: out.fromAfter, toBalance: out.toAfter }, });
      case 'settings': return A('settings.payment', who(w) + ' changed the payment settings (' + ['gcashNumber', 'accountName', 'qr', 'removeQr'].filter(k => b[k] !== undefined && b[k] !== '' && b[k] !== false).join(', ') + ')', {});
      default: return;
    }
  } catch (e) { console.error('audit failed:', e && e.message); }
}

const actions = {
  /* ----- Super Admin: the Audit Trail (read only: nothing here, or anywhere, edits or deletes a record) ----- */
  async 'audit-list'(w, b) {
    need(w.isSuper && !w.suspended, 403, 'Only the Super Admin can open the Audit Trail.');
    const all = await B.allMap('audit'), q = String(b.q || '').trim().toLowerCase(), area = String(b.area || ''), actor = String(b.actor || '').trim().toLowerCase();
    const from = Number(b.from) || 0, to = Number(b.to) || 0, before = String(b.before || ''), limit = Math.min(200, Math.max(10, Number(b.limit) || 60));
    const rows = Object.keys(all).sort().reverse().map(id => Object.assign({ id }, all[id]));
    const areas = Array.from(new Set(rows.map(r => r.area))).sort(), tampered = rows.filter(r => r.sig !== L.auditSig(r)).length;
    let list = rows.filter(r => (!area || r.area === area) && (!from || r.at >= from) && (!to || r.at <= to)
      && (!actor || [r.actor && r.actor.name, r.actor && r.actor.id, r.actor && r.actor.role].join(' ').toLowerCase().indexOf(actor) >= 0)
      && (!q || [r.summary, r.action, r.actor && r.actor.name, r.subject && r.subject.name, JSON.stringify(r.refs || {})].join(' ').toLowerCase().indexOf(q) >= 0));
    const total = list.length;
    if (before) list = list.filter(r => r.id < before);
    const page = list.slice(0, limit);
    return { items: page.map(r => { const o = Object.assign({}, r, { verified: r.sig === L.auditSig(r) }); delete o.sig; return o; }), total, hasMore: list.length > page.length, areas, tampered, all: rows.length };
  },
  // Compares each stored refund balance with the sum of its ledger entries (the history of every credit and use).
  async 'balance-check'(w) {
    need(w.isSuper && !w.suspended, 403, 'Only the Super Admin can run this check.');
    const [bals, led, members] = await Promise.all([B.allMap('balances'), B.allMap('ledger'), B.allMap('members')]);
    const sums = {}; Object.keys(led).forEach(k => { const e = led[k]; if (e && e.uid) sums[e.uid] = Math.round(((sums[e.uid] || 0) + (Number(e.amount) || 0)) * 100) / 100; });
    const uids = Array.from(new Set(Object.keys(bals).concat(Object.keys(sums)))), bad = [];
    uids.forEach(uid => { const stored = Math.round((Number((bals[uid] || {}).amount) || 0) * 100) / 100, ledger = sums[uid] || 0; if (Math.abs(stored - ledger) >= 0.005) bad.push({ uid, name: (members[uid] && members[uid].name) || uid, stored, ledger, diff: Math.round((stored - ledger) * 100) / 100, reserved: Number((bals[uid] || {}).reserved) || 0, entries: Object.keys(led).filter(k => led[k].uid === uid).length }); });
    return { checked: uids.length, mismatches: bad };
  },
  // Sets a stored balance back to what its ledger adds up to. Nothing else changes: no ledger entry, payment or refund record is touched, and the change is audited.
  async 'balance-fix'(w, b) {
    need(w.isSuper && !w.suspended, 403, 'Only the Super Admin can correct a balance.');
    const uid = String(b.uid || ''), seen = Number(b.seen), reason = String(b.reason || '').trim();
    need(b.confirm === true && uid && Number.isFinite(seen), 400, 'Confirm the correction first.');
    need(reason.length >= 3 && reason.length <= 200, 400, 'Write a short reason for the correction (3 to 200 characters).');
    const led = await B.allMap('ledger'); let target = 0;
    Object.keys(led).forEach(k => { if (led[k].uid === uid) target += Number(led[k].amount) || 0; });
    target = Math.round(target * 100) / 100;
    const m = await L.getDoc('members', uid); need(m, 404, 'Account not found.');
    return await withBalance(uid, async () => {
      const bal = await getBal(uid), cur = Math.round(bal.amount * 100) / 100;
      need(Math.abs(cur - Math.round(seen * 100) / 100) < 0.005, 409, 'This balance changed since you checked it (it is now ' + B.money(cur) + '). Run the check again.');
      need(Math.abs(cur - target) >= 0.005, 409, 'This balance already matches its history.');
      need(target >= 0, 409, 'Its history adds up to a negative amount, so it cannot be set automatically.');
      await putBal(uid, Object.assign({}, bal, { amount: target }));
      await L.bump();
      await L.audit(w, 'balance.correct', who(w) + ' corrected the Refundable Balance of ' + m.name + ' from ' + B.money(cur) + ' to ' + B.money(target) + ' (its ledger history): ' + reason, { subject: { id: uid, name: m.name }, before: { balance: cur }, after: { balance: target }, amount: Math.round((target - cur) * 100) / 100, refs: { reason } });
      return { ok: true, balance: target };
    });
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

  /* ----- paying for a new booking: GCash (reference number and receipt are both required), the refund balance, or both ----- */
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
      if (!b.useBalance) {
        const { payId, doc } = await submitPayment(w, b, { kind: 'booking', ref, amount: total, slots: lines, extra: { total, balanceUsed: 0 }, apply: async id => toPending(id)() });
        await L.bump();
        await tellReviewers(w, payId, doc);
        return { ok: true, paymentId: payId, status: 'pending_verification', amount: total, total, balanceUsed: 0 };
      }
      return await withBalance(w.uid, async () => {
        const bal = await getBal(w.uid), avail = bal.amount - bal.reserved;
        need(avail > 0, 400, 'You have no refund balance to use.');
        const use = Math.min(avail, total), rest = total - use;
        if (rest === 0) {   // the balance covers everything: nothing for staff to verify, so the booking is confirmed now and the balance is deducted
          const payId = newId('p_'), now = Date.now();
          for (const x of slots) { const nx = Object.assign({}, x, { status: 'confirmed', paid: x.price, payId }); delete nx.id; delete nx.holdUntil; await put('bookings', x.id, nx); }
          await put('payments', payId, { kind: 'booking', bookingRef: ref, by: w.uid, byName: w.member.name, email: await payerEmail(w, b.email), amount: 0, total, balanceUsed: total, method: 'balance', status: 'paid', slots: lines, submittedAt: now, reviewedAt: now, reviewedByName: 'Refund balance' });
          await putBal(w.uid, Object.assign({}, bal, { amount: bal.amount - total }));
          await ledger(w.uid, 'booking-use', -total, bal.amount - total, { ref, payId });
          await L.bump();
          await tellBookingConfirmed(w.uid, w.member.name, payId, ref, slots, total, 'Paid with refund balance');
          return { ok: true, paymentId: payId, status: 'paid', confirmed: true, amount: 0, total, balanceUsed: total };
        }
        // part balance, part GCash: check the GCash fields first, then set the balance part aside so it cannot be spent twice while staff verify
        gcashInput(b);
        await putBal(w.uid, Object.assign({}, bal, { reserved: bal.reserved + use }));
        try {
          const { payId, doc } = await submitPayment(w, b, { kind: 'booking', ref, amount: rest, slots: lines, extra: { total, balanceUsed: use }, apply: async id => toPending(id)() });
          await L.bump();
          await tellReviewers(w, payId, doc);
          return { ok: true, paymentId: payId, status: 'pending_verification', amount: rest, total, balanceUsed: use };
        } catch (e) {
          const cur = await getBal(w.uid); await putBal(w.uid, Object.assign({}, cur, { reserved: Math.max(0, cur.reserved - use) }));
          throw e;
        }
      });
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
    if (diff <= 0) {   // no extra money needed: move straight away (claim the new hour first, then free the old one)
      const excess = Math.round(-diff * 100) / 100;   // paid more than the new hour costs: this difference is the only thing that can be credited
      await claimAll({ uid: from.by, member: { name: from.byName } }, [to], s => Object.assign({ date: s.date, venue: s.venue, court: s.court, hour: s.hour, paid: excess ? to.price : paidSoFar, status: 'confirmed' }, base));
      await del('bookings', b.id);
      let credited = 0, creditFailed = false;
      if (excess > 0) {   // only now that the move is complete; the ledger entry is the once-only marker
        try {
          await withBalance(from.by, async () => {
            const bal = await getBal(from.by), after = Math.round((bal.amount + excess) * 100) / 100;
            const key = 'rs_' + crypto.createHash('sha256').update(b.id + '|' + from.at + '|' + to.id).digest('hex').slice(0, 24);
            if (!(await putNew('ledger', key, { uid: from.by, type: 'resched-credit', amount: excess, balanceAfter: after, ref: from.ref, from: b.id, to: to.id, at: Date.now() }))) return;
            await putBal(from.by, Object.assign({}, bal, { amount: after }));
            credited = excess;
          });
        } catch (e) { creditFailed = true; console.error('reschedule credit failed:', e && e.message); }
      }
      await L.bump();
      await B.notify([from.by], { event: 'rescheduled', refId: from.ref + '.' + to.id, kind: 'rescheduled', title: 'Booking rescheduled', body: 'Your booking ' + from.ref + ' is now ' + B.scheduleText([to]) + '.' + (credited ? ' The ' + B.money(credited) + ' price difference was added to your Refundable Balance.' : ''), data: { ref: from.ref, slots: [{ venue: to.venue || '', court: to.court, date: to.date, hour: to.hour }], credited } });
      return { moved: true, amount: 0, credited, creditFailed, from: { date: from.date, venue: from.venue, court: from.court, hour: from.hour, paid: paidSoFar }, to: { date: to.date, venue: to.venue, court: to.court, hour: to.hour, price: to.price } };
    }
    need(owner, 403, 'This move costs more than was paid. Ask the player to reschedule from their own account so they can pay the difference.');
    if (!b.proof) return { needPayment: true, amount: diff, newPrice: to.price, paid: paidSoFar };   // nothing changes yet: the page now collects the balance
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
    if (pay.kind === 'booking' && Number(pay.balanceUsed) > 0) await withBalance(pay.by, async () => {
      const bal = await getBal(pay.by), after = Math.max(0, bal.amount - pay.balanceUsed);
      await putBal(pay.by, Object.assign({}, bal, { amount: after, reserved: Math.max(0, bal.reserved - pay.balanceUsed) }));
      await ledger(pay.by, 'booking-use', -pay.balanceUsed, after, { ref: pay.bookingRef, payId: id });
    });
    committed = true;
    } catch (e) { if (!committed) await unlock('ev:approve:' + id); throw e; }
    await L.bump();
    // told once, only now that the payment is verified
    const first = slots[0], when = B.scheduleText(slots);
    const resched = pay.kind === 'reschedule', used = Number(pay.balanceUsed) || 0;
    const data = { ref: pay.bookingRef, venue: first.venue || '', court: first.court, date: first.date, schedule: when, slots: slots.map(s => ({ venue: s.venue || '', court: s.court, date: s.date, hour: s.hour })),
      amount: resched ? pay.amount : (Number(pay.total) || pay.amount), what: resched ? 'reschedule' : 'booking', paidWith: used > 0 ? (pay.amount > 0 ? 'Refund Balance + GCash' : 'Refund Balance') : 'GCash', status: 'Confirmed' };
    await B.notify([pay.by], {
      event: 'payment-approved', refId: id, kind: 'payment-approved', data,
      title: pay.kind === 'reschedule' ? 'Reschedule confirmed ✓' : 'Payment approved ✓',
      body: 'Please go to ' + (first.venue || 'the venue') + ': ' + when + '. Your reference number is ' + pay.bookingRef + '. Show it to the venue staff before using the court.'
    });
    const staff = (await B.venueStaff(first.venue)).filter(u => u !== pay.by);
    await B.notify(staff, { event: 'booking-confirmed', refId: id, kind: 'booking-confirmed', data, title: 'New confirmed booking', body: pay.byName + ' · ' + pay.bookingRef + ' · ' + when + ' · Payment: Paid ' + B.money(pay.total || pay.amount) + '.' });
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
    if (pay.kind === 'booking' && Number(pay.balanceUsed) > 0) await withBalance(pay.by, async () => { const bal = await getBal(pay.by); await putBal(pay.by, Object.assign({}, bal, { reserved: Math.max(0, bal.reserved - pay.balanceUsed) })); });
    await put('payments', id, Object.assign({}, pay, { status: 'rejected', reason, reviewedBy: w.uid, reviewedByName: w.member.name, reviewedAt: Date.now() }));
    await L.bump();
    await B.notify([pay.by], { event: 'payment-rejected', refId: id, kind: 'payment-rejected', data: { ref: pay.bookingRef, reason }, title: 'Payment not approved', body: 'We could not verify your GCash payment for ' + pay.bookingRef + '.' + (reason ? ' Reason: ' + reason : '') + (pay.kind === 'reschedule' ? ' Your original booking is unchanged.' : ' Your hours are held for 30 minutes so you can send a corrected receipt.') });
    return { ok: true };
  },

  /* ----- cancelling. Staff can cancel anyone's booking; a player can cancel their OWN confirmed booking before it starts.
         A paid hour opens a refund for the player to choose how to receive (nothing is credited or sent until they choose) ----- */
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
      if (!staff) {   // a player can cancel their own confirmed booking, before or after it starts (until the hour ends)
        need(s.status !== 'hold', 409, 'This booking has not been paid yet. Close its payment window to release the hours.');
      }
    }
    // The refund rules: cancelled BEFORE the booked start time = full refund, which the player may take by GCash or as Refundable Balance.
    // Cancelled AFTER the start time = the amount paid goes to the Refundable Balance instead (never to GCash).
    const byPlayer = {}, now = Date.now();
    for (const s of slots) {
      await del('bookings', s.id);
      const paid = Number(s.paid) || 0;
      if (s.status === 'hold' || !paid) continue;
      if (!(await lockOnce('ev:refundslot:' + s.id + ':' + s.at, 1))) continue;   // this paid hour already produced a refund
      const after = B.startMs(s.date, s.hour) <= now, k = s.by + '|' + s.ref + '|' + (after ? 'after' : 'before');
      (byPlayer[k] = byPlayer[k] || []).push({ s, paid, pct: 100, refundable: paid, after });
    }
    const made = [], choose = []; let totalRefundable = 0, totalPaid = 0, chooseAmount = 0, credited = 0, balance = null;
    for (const key of Object.keys(byPlayer)) {
      const g = byPlayer[key], first = g[0].s, after = g[0].after, id = newId('rf_'), paidSum = sum(g, x => x.paid), refundable = sum(g, x => x.refundable);
      const own = first.by === w.uid;   // the player cancelled it themselves: they already know, so no pop-up or push for it
      totalPaid += paidSum; totalRefundable += refundable;
      const doc = {
        bookingRef: first.ref, by: first.by, byName: first.byName, status: 'awaiting_user', method: null, requestedBy: w.uid, requestedByName: w.member.name, requestedAt: Date.now(),
        slots: g.map(x => ({ date: x.s.date, venue: x.s.venue, court: x.s.court, hour: x.s.hour, paid: x.paid, percent: x.pct })),
        paid: paidSum, refundable, rule: after ? 'after_start' : 'before_start', afterStart: after, policy: B.REFUND_RULES
      };
      await put('refunds', id, doc); made.push(id);
      if (after) {   // started hour: straight to the Refundable Balance (once; if that step fails the refund stays waiting and can only be kept as balance)
        try {
          balance = await creditRefundToBalance(id, doc, first.by, w); credited += refundable;
          await B.notify([first.by], { event: 'booking-cancelled', refId: id, kind: 'booking-cancelled', read: own, data: { ref: first.ref }, title: 'Booking cancelled', body: B.scheduleText(g.map(x => x.s)) + ' was cancelled after it started. ' + B.money(refundable) + ' was added to your Refundable Balance.' });
        } catch (e) {
          console.error('after-start credit failed:', e && e.message);
          choose.push(id); chooseAmount += refundable;
          await B.notify([first.by], { event: 'booking-cancelled', refId: id, kind: 'booking-cancelled', read: own, data: { ref: first.ref, refundId: id }, title: 'Booking cancelled: keep your refund', body: B.scheduleText(g.map(x => x.s)) + ' was cancelled after it started. ' + B.money(refundable) + ' goes to your Refundable Balance. Please confirm it.' });
        }
        continue;
      }
      choose.push(id); chooseAmount += refundable;
      await B.notify([first.by], { event: 'booking-cancelled', refId: id, kind: 'booking-cancelled', read: own, data: { ref: first.ref, refundId: id }, title: 'Booking cancelled: choose your refund', body: B.scheduleText(g.map(x => x.s)) + ' was cancelled before it started. You can get back ' + B.money(refundable) + '. Choose to request it by GCash or to keep it as refund balance for future bookings.' });
    }
    await L.bump();
    return { ok: true, refunds: made, choose, refundable: totalRefundable, paid: totalPaid, chooseAmount, credited, balance };
  },

  /* ----- the player: GCash details for refunds ----- */
  async 'refund-account'(w, b) {
    const n = String(b.number || '').replace(/[\s-]/g, ''), name = String(b.name || '').trim();
    const cur = (await L.getDoc('refundaccts', w.uid)) || {};
    const missing = [!n && 'the GCash number', !name && 'the account name', !b.qr && !cur.qrPath && 'the GCash QR code'].filter(Boolean);
    need(!missing.length, 400, 'Required: ' + missing.join(', ').replace(/, ([^,]*)$/, ' and $1') + '.');
    need(/^(\+?63|0)9\d{9}$/.test(n), 400, 'Enter a valid GCash number, like 09171234567.');
    need(name.length >= 2 && name.length <= 60, 400, 'Enter the account name shown in your GCash (2 to 60 characters).');
    let qrPath = cur.qrPath || '';
    if (b.qr) { const img = parseImage(b.qr); qrPath = 'refundqr/' + w.uid + '-' + Date.now() + '.' + img.ext; await L.putFile(qrPath, img.buf, img.type); }
    await put('refundaccts', w.uid, { number: n, name, qrPath, updatedAt: Date.now() });
    await L.bump();
    return { ok: true };
  },

  /* ----- the player: level (must be one of the levels in Session Configurations) ----- */
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

  /* ----- Super Admin and Admin: move an existing refund balance from an old account to a new one ----- */
  async 'balance-search'(w, b) {
    need(w.canLinkBalances, 403, 'Only a Super Admin or Admin can link refund balances.');
    const q = String(b.q || '').trim().toLowerCase();
    need(q.length >= 2, 400, 'Type at least 2 letters of the name, or the full email address.');
    const [members, roles, bals] = await Promise.all([B.allMap('members'), B.allMap('roles'), B.allMap('balances')]);
    let ids;
    if (q.indexOf('@') >= 0) { const id = L.emailId(L.normEmail(q)); ids = members[id] ? [id] : []; }
    else ids = Object.keys(members).filter(id => String(members[id].name || '').toLowerCase().indexOf(q) >= 0).slice(0, 10);
    return { results: ids.map(id => {
      const bl = Object.assign({ amount: 0, reserved: 0 }, bals[id]), rl = (roles[id] && roles[id].role) || 'player';
      return { id, name: members[id].name, role: rl, since: members[id].createdAt || null, suspended: !!(roles[id] && roles[id].suspended), avatar: members[id].avatar || '', amount: bl.amount, reserved: bl.reserved, available: Math.max(0, bl.amount - bl.reserved) };
    }) };
  },
  async 'balance-link'(w, b) {
    need(w.canLinkBalances, 403, 'Only a Super Admin or Admin can link refund balances.');
    const from = String(b.from || ''), to = String(b.to || ''), key = String(b.key || ''), reason = String(b.reason || '').trim();
    need(b.confirm === true, 400, 'Confirm the transfer first.');
    need(/^[\w-]{8,64}$/.test(key), 400, 'Bad request. Reload the page and try again.');
    need(from && to, 400, 'Choose both the old account and the new account.');
    need(from !== to, 400, 'The old and the new account must be different accounts.');
    need(reason.length >= 3 && reason.length <= 200, 400, 'Write a short reason for the transfer (3 to 200 characters).');
    const [fm, tm] = await Promise.all([L.getDoc('members', from), L.getDoc('members', to)]);
    need(fm, 404, 'The old account was not found.');
    need(tm, 404, 'The new account was not found.');
    const amount = Math.round(Number(b.amount) * 100) / 100, expected = Math.round(Number(b.expected) * 100) / 100;
    need(Number.isFinite(amount) && amount > 0, 400, 'Enter an amount greater than zero.');
    need(Number.isFinite(expected), 400, 'Bad request. Search for the account again.');
    need(await lockOnce('ev:balink:' + key, w.uid), 409, 'This transfer was already submitted.');   // a double click or a replay does nothing
    const id = newId('bl_'), order = [from, to].sort();
    try {
      return await withBalance(order[0], () => withBalance(order[1], async () => {
        const fb = await getBal(from), tb = await getBal(to), avail = Math.round((fb.amount - fb.reserved) * 100) / 100;
        need(avail > 0, 409, 'The old account has no refund balance to transfer.');
        need(avail === expected, 409, 'The old account\'s balance changed (it is now ' + B.money(avail) + '). Search again and check it before confirming.');
        need(amount <= avail, 400, 'The old account only has ' + B.money(avail) + ' available to transfer.');
        const fromAfter = Math.round((fb.amount - amount) * 100) / 100, toAfter = Math.round((tb.amount + amount) * 100) / 100, at = Date.now();
        const audit = { id, from, fromName: fm.name, to, toName: tm.name, amount, fromBefore: fb.amount, fromAfter, toBefore: tb.amount, toAfter, reason, by: w.uid, byName: w.member.name, byRole: w.role, at, status: 'done' };
        need(await putNew('balancelinks', id, Object.assign({}, audit, { status: 'pending' })), 409, 'This transfer was already submitted.');
        try {
          await putBal(from, Object.assign({}, fb, { amount: fromAfter }));
          try { await putBal(to, Object.assign({}, tb, { amount: toAfter })); }
          catch (e) { await putBal(from, fb); throw e; }   // put the old balance back: never half a transfer
        } catch (e) { await put('balancelinks', id, Object.assign({}, audit, { status: 'failed' })); throw e; }
        await ledger(from, 'link-out', -amount, fromAfter, { linkId: id, other: to, otherName: tm.name, by: w.uid, byName: w.member.name });
        await ledger(to, 'link-in', amount, toAfter, { linkId: id, other: from, otherName: fm.name, by: w.uid, byName: w.member.name });
        await put('balancelinks', id, audit);
        await L.bump();
        await B.notify([from], { event: 'balance-link-out', refId: id, kind: 'balance-linked', read: true, data: { amount, linkId: id }, title: 'Refund balance moved', body: B.money(amount) + ' of your refund balance was moved to another account (' + tm.name + ') by an admin.' });
        await B.notify([to], { event: 'balance-link-in', refId: id, kind: 'balance-linked', data: { amount, linkId: id }, title: 'Refund balance added', body: B.money(amount) + ' was moved into your refund balance from ' + fm.name + ' by an admin.' });
        return { ok: true, id, amount, fromAfter, toAfter };
      }));
    } catch (e) { await unlock('ev:balink:' + key); throw e; }   // nothing moved: the same request may be tried again
  },

  /* ----- the player: how to receive a refund. This is an explicit choice and there is no default.
         GCash: becomes a request that staff process. Refund balance: credited right now, once, and never sent to GCash afterwards. ----- */
  async 'refund-choose'(w, b) {
    const id = String(b.id || ''), r = await L.getDoc('refunds', id), method = b.method;
    need(r && r.by === w.uid, 404, 'Refund not found.');
    need(method === 'gcash' || method === 'balance', 400, 'Choose "Request GCash Refund" or "Keep as Refund Balance".');
    need(B.isAwaiting(r), 409, r.status === 'refunded' ? 'This refund was already completed.' : 'You already chose how to receive this refund.');
    need(!(r.afterStart && method === 'gcash'), 400, 'This hour had already started when it was cancelled, so the refund goes to your Refundable Balance, not GCash.');
    if (method === 'gcash') {
      const a = await L.getDoc('refundaccts', w.uid);
      const miss = [!(a && a.number) && 'GCash number', !(a && a.name) && 'account name', !(a && a.qrPath) && 'GCash QR code'].filter(Boolean);
      need(!miss.length, 400, 'Your GCash refund details are incomplete. Add your ' + miss.join(', ').replace(/, ([^,]*)$/, ' and $1') + ' first (Refundable Balance, Edit GCash Details).');
      need(await lockOnce('ev:rfchoose:' + id, w.uid), 409, 'You already chose how to receive this refund.');
      try { await put('refunds', id, Object.assign({}, r, { status: 'requested', method: 'gcash', acct: { number: a.number, name: a.name, qrPath: a.qrPath }, chosenAt: Date.now() })); }   // a request only: nothing is credited
      catch (e) { await unlock('ev:rfchoose:' + id); throw e; }
      await L.bump();
      const staff = await B.usersWith('refunds');
      await B.notify(staff.filter(u => u !== w.uid), { event: 'refund-requested', refId: id, kind: 'refund-requested', data: { refundId: id }, title: 'New GCash refund request', body: r.byName + ' · ' + r.bookingRef + ' · ' + B.money(r.refundable) + ' to send to GCash ' + a.number + '.' });
      return { ok: true, method: 'gcash', status: 'requested' };
    }
    const newBalance = await creditRefundToBalance(id, r, w.uid, w);
    return { ok: true, method: 'balance', status: 'refunded', credited: r.refundable, balance: newBalance };
  },

  /* ----- staff: refunds. Refund balance is credited on approval; a GCash refund is sent by hand, then recorded with its reference and receipt ----- */
  async 'refund-approve'(w, b) {
    need(w.can('refunds'), 403, 'Your role cannot process refunds.');
    const id = String(b.id || ''), r = await L.getDoc('refunds', id);
    need(r, 404, 'Refund not found.');
    need(r.status !== 'refunded', 409, 'This refund was already completed.');
    need(r.status !== 'denied', 409, 'This refund was denied, so it cannot be approved.');
    need(!B.isAwaiting(r), 409, NOT_CHOSEN);
    need(r.status === 'requested', 409, 'This refund was already approved. The next step is to process it: send the money and record it.');
    let amount = r.refundable;
    if (b.amount !== undefined && b.amount !== '') { amount = Math.round(Number(b.amount)); need(amount >= 0 && amount <= r.paid, 400, 'The refund cannot be more than was paid (' + B.money(r.paid) + ').'); }
    need(await lockOnce('ev:rfapprove:' + id, w.uid), 409, 'This refund is already being approved.');
    try {
      if (r.method === 'balance') {
        let newBalance = 0;
        await withBalance(r.by, async () => {
          const bal = await getBal(r.by);
          newBalance = bal.amount + amount;
          if (!(await putNew('ledger', 'credit_' + id, { uid: r.by, type: 'refund-credit', amount, balanceAfter: bal.amount + amount, refundId: id, ref: r.bookingRef, at: Date.now() }))) throw err(409, 'This refund was already credited to the balance.');
          await putBal(r.by, Object.assign({}, bal, { amount: bal.amount + amount }));
        });
        await put('refunds', id, Object.assign({}, r, { status: 'refunded', refundable: amount, actualAmount: amount, refundRef: 'REFUND BALANCE', approvedBy: w.uid, approvedByName: w.member.name, approvedAt: Date.now(), refundedBy: w.uid, refundedByName: w.member.name, refundedAt: Date.now() }));
        await L.bump();
        await B.notify([r.by], { event: 'refund-done', refId: id, kind: 'refund-done', data: { ref: r.bookingRef, amount, method: 'balance', balance: newBalance }, title: 'Refund added to your balance', body: B.money(amount) + ' from booking ' + r.bookingRef + ' was added to your refund balance. You can use it to pay for your next booking.' });
        return { ok: true };
      }
      await put('refunds', id, Object.assign({}, r, { status: 'approved', refundable: amount, approvedBy: w.uid, approvedByName: w.member.name, approvedAt: Date.now() }));
    } catch (e) { await unlock('ev:rfapprove:' + id); throw e; }
    await L.bump();
    return { ok: true };
  },
  // GCash refunds: staff send the money by hand, then record the amount really sent, the GCash reference and the receipt. All three are required.
  async 'refund-complete'(w, b) {
    need(w.can('refunds'), 403, 'Your role cannot process refunds.');
    const id = String(b.id || ''), r = await L.getDoc('refunds', id), gref = normRef(b.gcashRef);
    need(r, 404, 'Refund not found.');
    need(r.status !== 'refunded', 409, 'This refund was already completed.');
    need(r.status !== 'denied', 409, 'This refund was denied, so it cannot be processed.');
    need(!B.isAwaiting(r), 409, NOT_CHOSEN);   // this also catches refunds opened before players could choose a method
    need(r.method === 'gcash', 400, 'The player chose to keep this refund as refund balance, so there is nothing to send by GCash.');
    need(B.acctOk(r.acct), 409, "This request has no usable GCash details (the player's number, account name and QR code), so there is nowhere to send the money. Press \"Fix and remind\": it returns the request to the player to add their details and choose again.");
    need(gref.length >= 6 && gref.length <= 30, 400, 'Enter the GCash reference number of the refund you sent (6 to 30 letters and numbers).');
    need(b.amount !== undefined && b.amount !== '' && b.amount !== null, 400, 'Enter the amount you actually refunded.');   // the amount, the reference and the receipt are all mandatory
    const actual = Math.round(Number(b.amount));
    need(actual > 0 && actual <= r.paid, 400, 'Enter the amount you actually sent (more than 0 and not more than ' + B.money(r.paid) + ').');
    need(b.proof, 400, 'Upload the receipt (screenshot) of the refund you sent.');
    const img = parseImage(b.proof);
    need(await lockOnce('gcash:' + gref, id), 409, 'That GCash reference number was already used for another payment or refund. Check the reference on your receipt.');
    if (!(await lockOnce('ev:rfdone:' + id, w.uid))) { await unlock('gcash:' + gref); throw err(409, 'Someone else is processing this refund right now. Refresh to see its result.'); }
    try {
      const path = 'refundproofs/' + id + '.' + img.ext;
      await L.putFile(path, img.buf, img.type);
      await put('refunds', id, Object.assign({}, r, { status: 'refunded', method: 'gcash', approvedBy: r.approvedBy || w.uid, approvedByName: r.approvedByName || w.member.name, approvedAt: r.approvedAt || Date.now(), actualAmount: actual, refundRef: gref, receiptPath: path, refundedBy: w.uid, refundedByName: w.member.name, refundedAt: Date.now() }));
    } catch (e) { await unlock('gcash:' + gref); await unlock('ev:rfdone:' + id); throw e; }
    await L.bump();
    // told only now that the money has actually been sent
    await B.notify([r.by], { event: 'refund-done', refId: id, kind: 'refund-done', data: { ref: r.bookingRef, amount: actual, refundRef: gref, method: 'gcash', refundId: id }, title: 'Payment Refunded', body: B.money(actual) + ' for booking ' + r.bookingRef + ' was refunded to your GCash. Reference ' + gref + '.' });
    return { ok: true };
  },
  async 'refund-deny'(w, b) {
    need(w.can('refunds'), 403, 'Your role cannot process refunds.');
    const id = String(b.id || ''), r = await L.getDoc('refunds', id), reason = String(b.reason || '').trim().slice(0, 200);
    need(r, 404, 'Refund not found.');
    need(r.status === 'awaiting_user' || r.status === 'requested' || r.status === 'approved', 409, 'This refund was already completed or denied.');
    need(await lockOnce('ev:rfdeny:' + id, w.uid), 409, 'This refund is already being reviewed.');
    await put('refunds', id, Object.assign({}, r, { status: 'denied', reason, deniedBy: w.uid, deniedByName: w.member.name, deniedAt: Date.now() }));
    await L.bump();
    await B.notify([r.by], { event: 'refund-denied', refId: id, kind: 'refund-denied', data: { ref: r.bookingRef }, title: 'Refund not approved', body: 'Your refund request for ' + r.bookingRef + ' was not approved.' + (reason ? ' Reason: ' + reason : '') });
    return { ok: true };
  },

  /* ----- staff: "Fix and remind". Repairs a refund that is stuck, without refunding it, crediting anything or touching any payment record:
         - a refund opened before players could choose a method (status requested or approved, no method) goes back to "awaiting player";
         - a GCash request that has no usable GCash details goes back to the player to complete them;
         - a half-finished step (a leftover lock) is cleared, and a balance credit that was already recorded is finished (never credited again).
         The player is then reminded to choose. ----- */
  async 'refund-repair'(w, b) {
    need(w.can('refunds'), 403, 'Your role cannot process refunds.');
    const id = String(b.id || ''), r = await L.getDoc('refunds', id);
    need(r, 404, 'Refund not found.');
    need(r.status !== 'refunded' && r.status !== 'denied', 409, 'This refund is already ' + r.status + ', so there is nothing to repair.');
    const locks = await B.allMap('locks'), fixed = [];
    let doc = r;
    if (B.isAwaiting(r) && locks['ev:rfchoose:' + id] != null) {
      const credit = await L.getDoc('ledger', 'credit_' + id);
      if (credit) {   // the balance was credited but the refund record never caught up: finish it, without crediting again
        doc = Object.assign({}, r, { status: 'refunded', method: 'balance', actualAmount: credit.amount, refundRef: 'REFUND BALANCE', refundedAt: credit.at || Date.now(), refundedByName: 'Refund balance' });
        await put('refunds', id, doc); await L.bump(); fixed.push('finished a refund balance credit that had already been recorded (it was not credited again)');
        await B.notify([r.by], { event: 'refund-done', refId: id, kind: 'refund-done', data: { ref: r.bookingRef, amount: credit.amount, method: 'balance', balance: credit.balanceAfter }, title: 'Refund added to your balance', body: B.money(credit.amount) + ' from booking ' + r.bookingRef + ' was added to your refund balance.' });
        return { ok: true, fixed, status: 'refunded' };
      }
      await unlock('ev:rfchoose:' + id); fixed.push('cleared an unfinished choice');
    }
    const open = r.status === 'requested' || r.status === 'approved';
    if (open && !r.method) { doc = Object.assign({}, r, { status: 'awaiting_user', method: null, acct: null, legacyStatus: r.status, repairedAt: Date.now() }); fixed.push('returned to the player to choose how to receive it (it was opened before players could choose)'); }
    else if (open && r.method === 'gcash' && !B.acctOk(r.acct)) { doc = Object.assign({}, r, { status: 'awaiting_user', method: null, acct: null, repairedAt: Date.now() }); await unlock('ev:rfchoose:' + id); fixed.push("returned to the player to add their GCash details and choose again"); }
    for (const k of ['ev:rfapprove:' + id, 'ev:rfdone:' + id]) if (locks[k] != null && (doc.status === 'requested' || doc.status === 'approved' || doc.status === 'awaiting_user')) { await unlock(k); fixed.push('cleared an unfinished step'); }
    for (const k of Object.keys(locks)) if (k.startsWith('gcash:') && locks[k] === id) { await unlock(k); fixed.push('freed a GCash reference that was held by an unfinished refund'); }
    if (doc !== r) { await put('refunds', id, doc); await L.bump(); }
    if (doc.status === 'awaiting_user') {
      const day = new Date().toISOString().slice(0, 10);
      await B.notify([r.by], { event: 'refund-reminder', refId: id + '.' + day, kind: 'booking-cancelled', data: { ref: r.bookingRef, refundId: id }, title: 'Choose how to receive your refund', body: 'You can get back ' + B.money(r.refundable) + ' for booking ' + r.bookingRef + '. Choose to request it by GCash or to keep it as refund balance.' });
      fixed.push('reminded ' + (r.byName || 'the player') + ' to choose');
    }
    return { ok: true, fixed, status: doc.status };
  },

  /* ----- admin: GCash details, QR code and refund policy ----- */
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
    if (b.refundPolicy !== undefined) { need(Array.isArray(b.refundPolicy) && b.refundPolicy.length <= 8, 400, 'Bad refund policy.'); next.refundPolicy = B.normPolicy(b.refundPolicy); }
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
  need(/^(qr|proofs|refundqr|refundproofs|avatars)\/[\w.\-]+$/.test(path), 400, 'Bad file.');   // avatars: any signed-in person
  if (path.startsWith('proofs/')) {
    const pay = await L.getDoc('payments', path.slice(7).replace(/\.\w+$/, ''));
    need(pay && (pay.by === w.uid || w.can('payments')), 403, 'You cannot view this file.');
  }
  if (path.startsWith('refundqr/')) need(path.slice(9).startsWith(w.uid + '-') || w.can('refunds'), 403, 'You cannot view this file.');
  if (path.startsWith('refundproofs/')) {
    const rf = await L.getDoc('refunds', path.slice(13).replace(/\.\w+$/, ''));
    need(rf && (rf.by === w.uid || w.can('refunds')), 403, 'You cannot view this file.');
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
    need(!w.suspended, 403, 'Your access is paused.');
    const fn = actions[b.action];
    need(fn, 400, 'Unknown action.');
    await L.throttle('pay:' + w.uid, 120, 600);
    const pre = await auditPre(w, b), out = await fn(w, b);
    await auditPost(w, b, pre, out);
    res.status(200).json(out);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('pay error:', e && e.message);
    res.status(status).json({ error: status >= 500 && !e.status ? 'Something went wrong.' : e.message });
  }
};
