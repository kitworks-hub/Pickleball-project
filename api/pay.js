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
  const gref = normRef(b.gcashRef);
  need(gref.length >= 8 && gref.length <= 30, 400, 'Enter the GCash reference number from your receipt (8 to 30 letters and numbers).');
  const img = parseImage(b.proof);
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

const actions = {
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

  /* ----- GCash proof for a new booking ----- */
  async pay(w, b) {
    const ref = String(b.ref || '');
    need(await lockOnce('payref:' + ref, w.uid), 409, 'This booking was already submitted for payment.');
    try {
      const slots = (await bookingsOf(ref)).filter(x => x.by === w.uid);
      need(slots.length, 404, 'We could not find that booking.');
      need(slots.every(x => x.status === 'hold'), 409, 'This booking was already submitted for payment verification.');
      need(slots.every(x => B.occupies(x)), 409, 'Your hold on these hours ran out. Please pick the hours again.');
      const amount = sum(slots, x => x.price);
      const { payId, doc } = await submitPayment(w, b, {
        kind: 'booking', ref, amount, slots: slots.map(x => ({ date: x.date, venue: x.venue, court: x.court, hour: x.hour, price: x.price })),
        apply: async payId => { for (const x of slots) { const nx = Object.assign({}, x, { status: 'pending', payId }); delete nx.id; delete nx.holdUntil; await put('bookings', x.id, nx); } }
      });
      await L.bump();
      await tellReviewers(w, payId, doc);
      return { ok: true, paymentId: payId, status: 'pending_verification', amount };
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
      await claimAll({ uid: from.by, member: { name: from.byName } }, [to], s => Object.assign({ date: s.date, venue: s.venue, court: s.court, hour: s.hour, paid: paidSoFar, status: 'confirmed' }, base));
      await del('bookings', b.id);
      await L.bump();
      await B.notify([from.by], { event: 'rescheduled', refId: from.ref + '.' + to.id, kind: 'rescheduled', title: 'Booking rescheduled', body: 'Your booking ' + from.ref + ' is now ' + B.scheduleText([to]) + '.', data: { ref: from.ref } });
      return { moved: true, amount: 0 };
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
    committed = true;
    } catch (e) { if (!committed) await unlock('ev:approve:' + id); throw e; }
    await L.bump();
    // told once, only now that the payment is verified
    const first = slots[0], when = B.scheduleText(slots);
    const data = { ref: pay.bookingRef, venue: first.venue || '', court: first.court, date: first.date, schedule: when };
    await B.notify([pay.by], {
      event: 'payment-approved', refId: id, kind: 'payment-approved', data,
      title: pay.kind === 'reschedule' ? 'Reschedule confirmed ✓' : 'Payment approved ✓',
      body: 'Please go to ' + (first.venue || 'the venue') + ': ' + when + '. Your reference number is ' + pay.bookingRef + '. Show it to the venue staff before using the court.'
    });
    const staff = (await B.venueStaff(first.venue)).filter(u => u !== pay.by);
    await B.notify(staff, { event: 'booking-confirmed', refId: id, kind: 'booking-confirmed', data, title: 'New confirmed booking', body: pay.byName + ' · ' + pay.bookingRef + ' · ' + when + ' · Payment: Paid ' + B.money(pay.amount) + '.' });
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

  /* ----- staff: cancel hours (this is what creates refund requests) ----- */
  async cancel(w, b) {
    need(w.can('managebookings'), 403, 'Your role cannot cancel bookings.');
    const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 48) : [];
    need(ids.length, 400, 'Nothing to cancel.');
    const slots = [];
    for (const id of ids) { const s = await L.getDoc('bookings', id); if (s && s.by) slots.push(Object.assign({ id }, s)); }
    need(slots.length, 404, 'That booking no longer exists.');
    const pays = await B.allMap('payments');
    for (const s of slots) {
      need(s.status !== 'pending' && s.status !== 'resched', 409, 'This booking is waiting for payment verification. Approve or deny the payment first.');
      need(!Object.keys(pays).some(k => pays[k].status === 'pending_verification' && pays[k].move && pays[k].move.from === s.id), 409, 'A reschedule for this hour is waiting for payment verification. Approve or deny it first.');
    }
    const policy = (await B.payCfg()).refundPolicy, byPlayer = {};
    for (const s of slots) {
      await del('bookings', s.id);
      const paid = Number(s.paid) || 0;
      if (s.status === 'hold' || !paid) continue;
      if (!(await lockOnce('ev:refundslot:' + s.id + ':' + s.at, 1))) continue;   // this paid hour already produced a refund request
      const hoursUntil = (B.startMs(s.date, s.hour) - Date.now()) / 3600000, pct = B.refundPercent(policy, hoursUntil);
      (byPlayer[s.by + '|' + s.ref] = byPlayer[s.by + '|' + s.ref] || []).push({ s, paid, pct, refundable: Math.round(paid * pct / 100) });
    }
    const made = [];
    for (const key of Object.keys(byPlayer)) {
      const g = byPlayer[key], first = g[0].s, id = newId('rf_');
      const doc = {
        bookingRef: first.ref, by: first.by, byName: first.byName, status: 'requested', requestedBy: w.uid, requestedByName: w.member.name, requestedAt: Date.now(),
        slots: g.map(x => ({ date: x.s.date, venue: x.s.venue, court: x.s.court, hour: x.s.hour, paid: x.paid, percent: x.pct })),
        paid: sum(g, x => x.paid), refundable: sum(g, x => x.refundable), policy
      };
      await put('refunds', id, doc); made.push(id);
      await B.notify([first.by], { event: 'booking-cancelled', refId: id, kind: 'booking-cancelled', data: { ref: first.ref, refundId: id }, title: 'Booking cancelled', body: B.scheduleText(g.map(x => x.s)) + ' was cancelled. ' + (doc.refundable ? 'A refund of ' + B.money(doc.refundable) + ' was requested; you will be told when it is sent.' : 'No refund applies under the refund policy.') });
      const staff = await B.usersWith('refunds');
      await B.notify(staff.filter(u => u !== w.uid), { event: 'refund-requested', refId: id, kind: 'refund-requested', data: { refundId: id }, title: 'New refund request', body: first.byName + ' · ' + first.ref + ' · refundable ' + B.money(doc.refundable) + ' of ' + B.money(doc.paid) + '.' });
    }
    await L.bump();
    return { ok: true, refunds: made };
  },

  /* ----- staff: refunds (the GCash transfer itself is made by hand, then recorded here) ----- */
  async 'refund-approve'(w, b) {
    need(w.can('refunds'), 403, 'Your role cannot process refunds.');
    const id = String(b.id || ''), r = await L.getDoc('refunds', id);
    need(r, 404, 'Refund not found.');
    need(r.status === 'requested', 409, 'This refund was already reviewed.');
    let amount = r.refundable;
    if (b.amount !== undefined && b.amount !== '') { amount = Math.round(Number(b.amount)); need(amount >= 0 && amount <= r.paid, 400, 'The refund cannot be more than was paid (' + B.money(r.paid) + ').'); }
    need(await lockOnce('ev:rfapprove:' + id, w.uid), 409, 'This refund is already being approved.');
    await put('refunds', id, Object.assign({}, r, { status: 'approved', refundable: amount, approvedBy: w.uid, approvedByName: w.member.name, approvedAt: Date.now() }));
    await L.bump();
    return { ok: true };
  },
  async 'refund-complete'(w, b) {
    need(w.can('refunds'), 403, 'Your role cannot process refunds.');
    const id = String(b.id || ''), r = await L.getDoc('refunds', id), gref = normRef(b.gcashRef);
    need(r, 404, 'Refund not found.');
    need(r.status === 'approved', 409, r.status === 'refunded' ? 'This refund was already completed.' : 'Approve the refund first.');
    need(gref.length >= 6 && gref.length <= 30, 400, 'Enter the GCash reference number of the refund you sent.');
    need(await lockOnce('gcash:' + gref, id), 409, 'That GCash reference number was already used.');
    if (!(await lockOnce('ev:rfdone:' + id, w.uid))) { await unlock('gcash:' + gref); throw err(409, 'This refund is already being completed.'); }
    await put('refunds', id, Object.assign({}, r, { status: 'refunded', refundRef: gref, refundedBy: w.uid, refundedByName: w.member.name, refundedAt: Date.now() }));
    await L.bump();
    // told only now that the money has actually been sent
    await B.notify([r.by], { event: 'refund-done', refId: id, kind: 'refund-done', data: { ref: r.bookingRef, amount: r.refundable, refundRef: gref }, title: 'Payment Refunded', body: B.money(r.refundable) + ' for booking ' + r.bookingRef + ' was refunded to your GCash. Reference ' + gref + '.' });
    return { ok: true };
  },
  async 'refund-deny'(w, b) {
    need(w.can('refunds'), 403, 'Your role cannot process refunds.');
    const id = String(b.id || ''), r = await L.getDoc('refunds', id), reason = String(b.reason || '').trim().slice(0, 200);
    need(r, 404, 'Refund not found.');
    need(r.status === 'requested' || r.status === 'approved', 409, 'This refund was already completed or denied.');
    need(await lockOnce('ev:rfdeny:' + id, w.uid), 409, 'This refund is already being reviewed.');
    await put('refunds', id, Object.assign({}, r, { status: 'denied', reason, deniedBy: w.uid, deniedByName: w.member.name, deniedAt: Date.now() }));
    await L.bump();
    await B.notify([r.by], { event: 'refund-denied', refId: id, kind: 'refund-denied', data: { ref: r.bookingRef }, title: 'Refund not approved', body: 'Your refund request for ' + r.bookingRef + ' was not approved.' + (reason ? ' Reason: ' + reason : '') });
    return { ok: true };
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

function publicConfig() {
  let fb = null;
  try { fb = process.env.FIREBASE_WEB_CONFIG ? JSON.parse(process.env.FIREBASE_WEB_CONFIG) : null; } catch (e) { fb = null; }
  return {
    realtime: process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY ? { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY, topic: 'mpc-sync' } : null,
    firebase: fb && process.env.FIREBASE_VAPID_KEY ? { config: fb, vapidKey: process.env.FIREBASE_VAPID_KEY } : null
  };
}

async function sendFile(req, res) {
  const w = await L.whoIs(req), path = String(req.query.file || '');
  need(/^(qr|proofs)\/[\w.\-]+$/.test(path), 400, 'Bad file.');
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
    need(!w.suspended, 403, 'Your access is paused.');
    const fn = actions[b.action];
    need(fn, 400, 'Unknown action.');
    await L.throttle('pay:' + w.uid, 120, 600);
    res.status(200).json(await fn(w, b));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('pay error:', e && e.message);
    res.status(status).json({ error: status >= 500 && !e.status ? 'Something went wrong.' : e.message });
  }
};
