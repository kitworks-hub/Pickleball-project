/* POST /api/auth  { action: 'signup' | 'login' | 'setpw' | 'password', ... }
   The server checks passwords and hands back a signed token; the data API only answers requests that carry one. */
'use strict';
const L = require('./_lib');

function ownerEmails() {
  return String(process.env.OWNER_EMAIL || '').split(',').map(L.normEmail).filter(Boolean);
}
function needsReset(role, member) {
  const at = role ? Number(role.pwReset) : 0;
  return !!at && at > Number((member && member.pwSetAt) || 0);
}
async function superExists() {
  const [roles, members] = await Promise.all([L.one(['HGETALL', L.K('roles')]), L.one(['HGETALL', L.K('members')])]);
  const have = {};
  for (let i = 0; i < members.length; i += 2) have[members[i]] = true;
  for (let i = 0; i < roles.length; i += 2) {
    const r = L.parse(roles[i + 1]);
    if (r && r.role === 'super_admin' && have[roles[i]]) return true;
  }
  return false;
}
function pwOk(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw L.httpErr(400, 'Use at least 8 characters for your password.');
  if (pw.length > 200) throw L.httpErr(400, 'That password is too long.');
}

const actions = {
  async signup(b, req) {
    const email = L.normEmail(b.email), name = String(b.name || '').trim().slice(0, 80);
    if (!name) throw L.httpErr(400, 'Enter your full name.');
    if (!L.validEmail(email)) throw L.httpErr(400, 'Enter a valid email address.');
    pwOk(b.password);
    await L.throttle('signup:' + L.clientIp(req), 15, 3600);
    const id = L.emailId(email);
    const now = Date.now();
    const created = await L.one(['HSETNX', L.K('members'), id, JSON.stringify({ name, createdAt: now, pwSetAt: now })]);
    if (!created) throw L.httpErr(409, 'An account with that email already exists. Log in instead.');
    await L.one(['HSET', L.K('logins'), id, JSON.stringify(await L.makeCred(email, b.password))]);
    // The first account made with the OWNER_EMAIL address becomes the super admin. Everyone else starts as a player.
    if (ownerEmails().includes(email) && !(await superExists())) {
      await L.one(['HSET', L.K('roles'), id, JSON.stringify({ role: 'super_admin', owner: true, by: id, at: now })]);
    }
    await L.bump();
    return { token: L.signToken(id), id };
  },

  async login(b, req) {
    const email = L.normEmail(b.email);
    if (!L.validEmail(email) || typeof b.password !== 'string' || !b.password) throw L.httpErr(400, 'Enter your email and password.');
    const id = L.emailId(email);
    const key = 'login:' + id + ':' + L.clientIp(req);
    await L.throttle(key, 8, 600);
    const [member, role, cred] = await Promise.all([L.getDoc('members', id), L.getDoc('roles', id), L.getDoc('logins', id)]);
    if (member && needsReset(role, member)) return { status: 'reset', id };   // an admin reset this password: choose a new one
    if (!member || !(await L.checkCred(cred, email, b.password))) throw L.httpErr(401, 'That email and password do not match.');
    await L.clearThrottle(key);
    return { status: 'ok', token: L.signToken(id), id };
  },

  // Choosing a new password after an admin reset (no old password; the reset flag must still be pending).
  async setpw(b, req) {
    const email = L.normEmail(b.email);
    if (!L.validEmail(email)) throw L.httpErr(400, 'Enter a valid email address.');
    pwOk(b.password);
    const id = L.emailId(email);
    await L.throttle('setpw:' + id + ':' + L.clientIp(req), 8, 600);
    const [member, role] = await Promise.all([L.getDoc('members', id), L.getDoc('roles', id)]);
    if (!member || !needsReset(role, member)) throw L.httpErr(403, 'No password reset is waiting for that email.');
    await L.one(['HSET', L.K('logins'), id, JSON.stringify(await L.makeCred(email, b.password))]);
    await L.one(['HSET', L.K('members'), id, JSON.stringify(Object.assign({}, member, { pwSetAt: Date.now() }))]);
    await L.bump();
    return { status: 'ok', token: L.signToken(id), id };
  },

  // "Forgot password?": looks the email up (its hash is the account id) and, if the account exists, hands back a 10-minute reset
  // token so the page can go straight to "Choose a new password". The email itself is never stored. Admin and Super Admin
  // accounts are left out unless ALLOW_ADMIN_SELF_RESET=yes, because anyone who knows an email could otherwise take that account.
  async forgot(b, req) {
    const email = L.normEmail(b.email);
    if (!L.validEmail(email)) throw L.httpErr(400, 'Enter a valid email address.');
    const id = L.emailId(email);
    await L.throttle('forgot-ip:' + L.clientIp(req), 20, 600);
    await L.throttle('forgot:' + id, 8, 600);
    const [member, role, cred] = await Promise.all([L.getDoc('members', id), L.getDoc('roles', id), L.getDoc('logins', id)]);
    if (!member) throw L.httpErr(404, 'We could not find an account with that email. Check the spelling, or sign up.');
    const elevated = role && (role.role === 'super_admin' || role.role === 'admin' || role.owner);
    if (elevated && process.env.ALLOW_ADMIN_SELF_RESET !== 'yes') throw L.httpErr(403, 'For safety, admin accounts cannot be reset this way. Ask the Super Admin to reset your password from the Users page.');
    return { token: L.signPayload({ t: 'reset', id, email, n: cred ? cred.setAt : 0 }, 600000), id };
  },

  // Choosing a new password after "Forgot password?". The token works once: it dies as soon as the password changes.
  async resetpw(b, req) {
    pwOk(b.password);
    await L.throttle('resetpw-ip:' + L.clientIp(req), 20, 600);
    const p = L.verifyPayload(b.token);
    if (!p || p.t !== 'reset' || !p.id || !p.email || L.emailId(p.email) !== p.id) throw L.httpErr(400, 'This reset has expired. Start again with "Forgot password?".');
    const [member, cred] = await Promise.all([L.getDoc('members', p.id), L.getDoc('logins', p.id)]);
    if (!member) throw L.httpErr(400, 'This reset has expired. Start again with "Forgot password?".');
    if ((cred ? cred.setAt : 0) !== p.n) throw L.httpErr(400, 'This reset was already used. Start again with "Forgot password?" if you still need it.');
    await L.one(['HSET', L.K('logins'), p.id, JSON.stringify(await L.makeCred(p.email, b.password))]);
    await L.one(['HSET', L.K('members'), p.id, JSON.stringify(Object.assign({}, member, { pwSetAt: Date.now() }))]);
    await L.bump();
    return { status: 'ok', token: L.signToken(p.id), id: p.id };
  },

  // Change your own password (needs the current one).
  async password(b, req) {
    const tok = L.readToken(req);
    if (!tok) throw L.httpErr(401, 'Please log in again.');
    const email = L.normEmail(b.email);
    if (!L.validEmail(email) || L.emailId(email) !== tok.id) throw L.httpErr(400, 'Log out and log in again first.');
    pwOk(b.next);
    const key = 'pw:' + tok.id + ':' + L.clientIp(req);
    await L.throttle(key, 8, 600);
    const [member, cred] = await Promise.all([L.getDoc('members', tok.id), L.getDoc('logins', tok.id)]);
    if (!member) throw L.httpErr(401, 'This account no longer exists.');
    if (!(await L.checkCred(cred, email, String(b.current || '')))) throw L.httpErr(401, 'Your current password is not right.');
    await L.clearThrottle(key);
    await L.one(['HSET', L.K('logins'), tok.id, JSON.stringify(await L.makeCred(email, b.next))]);
    await L.one(['HSET', L.K('members'), tok.id, JSON.stringify(Object.assign({}, member, { pwSetAt: Date.now() }))]);
    await L.bump();
    return { status: 'ok' };
  }
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') throw L.httpErr(405, 'Use POST.');
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const fn = actions[b.action];
    if (!fn) throw L.httpErr(400, 'Unknown action.');
    res.status(200).json(await fn(b, req));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('auth error:', e && e.message);
    res.status(status).json({ error: status >= 500 && !e.status ? 'Something went wrong.' : e.message });
  }
};
