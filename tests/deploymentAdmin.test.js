const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment, getBaseUrl } = require('./helpers');
const { createCustomer, createAdmin } = require('./factories');
const User = require('../models/User');
const Order = require('../models/Order');
const { generateToken, generateRefreshToken } = require('../utils/generateToken');
const { getAdminPhones, getOwnerPhone, getAdminEmail } = require('../config/deploymentAdmin');
const { isOwnerPhone, isMasterOwner } = require('../config/masterOwner');
const { reconcileDeploymentAdmins } = require('../services/deploymentAdminService');

test.mock.method(require('../services/controlPlaneClient'), 'licenseStatus', async () => ({ managed: true, status: 'ACTIVE', features: [], limits: {} }));
test.before(startTestEnvironment);
test.after(stopTestEnvironment);
const ownerPhone = '7988634769', oldPhone = '9816978086', ownerEmail = 'nishaya.in1111@gmail.com';
test.beforeEach(async t => {
  await resetDatabase();
  t.mock.method(console, 'info', () => {});
  const env = { ADMIN_PHONE_NUMBERS: ownerPhone, ADMIN_EMAIL: ownerEmail, OTP_MODE: 'demo', OTP_RESEND_COOLDOWN_SECONDS: '0', SMS_PROVIDER: 'mock', AUTH_REFRESH_TOKEN_BODY: 'true' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(env)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const localFetch = global.fetch;
  t.mock.method(global, 'fetch', (url, options) => {
    assert.ok(String(url).startsWith(`${getBaseUrl()}/`), 'Only the isolated test API may be called');
    return localFetch(url, options);
  });
});

async function login(phone, otp = '123456') {
  return request('/api/auth/verify-otp', { method: 'POST', body: { phone, otp } });
}
function ok(result) { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
function accessLifetime(token) { const claims = jwt.decode(token); return claims.exp - claims.iat; }
async function ownerLogin(t) {
  process.env.OTP_MODE = 'production'; process.env.SMS_PROVIDER = '2factor';
  const configuration = { TWOFACTOR_API_KEY: 'isolated-test-key', TWOFACTOR_DELIVERY_MODE: 'transactional_sms', TWOFACTOR_SMS_SENDER_ID: 'NISHAY', TWOFACTOR_SMS_TEMPLATE: 'Your verification code is {otp}.', TWOFACTOR_DLT_ENTITY_ID: '1234567890123456789', TWOFACTOR_DLT_TEMPLATE_ID: '9876543210987654321' };
  const previous = Object.fromEntries(Object.keys(configuration).map(key => [key, process.env[key]]));
  Object.assign(process.env, configuration);
  t.after(() => { for (const key of Object.keys(configuration)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const localFetch = global.fetch; let otp;
  t.mock.method(global, 'fetch', (url, options) => {
    if (String(url).startsWith(`${getBaseUrl()}/`)) return localFetch(url, options);
    const target = new URL(url);
    assert.equal(target.hostname, '2factor.in');
    assert.equal(target.pathname, '/API/R1/');
    assert.equal(options.body.get('module'), 'TRANS_SMS');
    assert.equal(options.body.get('to'), `91${ownerPhone}`);
    otp = options.body.get('msg').match(/\b\d{6}\b/)[0];
    return new Response(JSON.stringify({ Status: 'Success', Details: 'isolated-test-session' }), { status: 200 });
  });
  const sent = ok(await request('/api/auth/send-otp', { method: 'POST', body: { phone: ownerPhone } }));
  assert.equal(sent.demoOtp, undefined); assert.match(otp, /^\d{6}$/);
  return ok(await login(ownerPhone, otp));
}

test('owner and regular admin configuration is normalized and no longer hardcoded to the old phone', () => {
  process.env.ADMIN_PHONE_NUMBERS = '+91 79886 34769, 9000000001';
  assert.equal(getOwnerPhone(), ownerPhone); assert.deepEqual(getAdminPhones(), [ownerPhone, '9000000001']);
  assert.equal(isOwnerPhone(oldPhone), false); assert.equal(isOwnerPhone(`+91${ownerPhone}`), true);
  assert.equal(getAdminEmail(), ownerEmail);
  process.env.ADMIN_PHONE_NUMBERS = '';
  assert.equal(isOwnerPhone(ownerPhone), false); assert.deepEqual(getAdminPhones(), []);
  process.env.ADMIN_PHONE_NUMBERS = 'invalid,9000000001';
  assert.equal(getOwnerPhone(), '', 'Invalid primary identity must not silently elevate the next admin');
});

test('startup demotes the legacy owner once, invalidates sessions and preserves their account and orders', async () => {
  const { user } = await createAdmin({ phone: oldPhone, systemRole: 'MASTER_OWNER', masterSessionVersion: 'old-owner-session', addresses: [{ fullName: 'Existing address' }] });
  const order = await Order.create({ user: user._id, paymentMethod: 'COD', orderStatus: 'Delivered' });
  const token = generateToken(user), refreshToken = generateRefreshToken(user);
  await reconcileDeploymentAdmins(); await reconcileDeploymentAdmins();
  const stored = await User.findById(user._id).select('+authSessionVersion +masterSessionVersion');
  assert.equal(stored.role, 'customer'); assert.equal(stored.activeMode, 'customer');
  assert.equal(stored.systemRole, 'USER'); assert.deepEqual([...stored.availableModes], ['customer']);
  assert.equal(stored.authSessionVersion, 1); assert.ok(!stored.masterSessionVersion);
  assert.equal(stored.addresses.length, 1); assert.equal(String((await Order.findById(order._id)).user), String(user._id));
  assert.equal((await request('/api/auth/me', { token })).status, 401);
  const renewed = await request('/api/auth/refresh', { method: 'POST', headers: { Cookie: `samira_refresh_token=${refreshToken}` }, body: { refreshToken } });
  assert.equal(renewed.status, 401);
});

test('a stale legacy admin access token is revoked on its first protected request even without a restart', async () => {
  const { user, token } = await createAdmin({ phone: oldPhone });
  assert.equal((await request('/api/admin/orders/admin/all', { token })).status, 401);
  assert.equal((await User.findById(user._id)).role, 'customer');
  ok(await request('/api/auth/send-otp', { method: 'POST', body: { phone: oldPhone } }));
  const customer = ok(await login(oldPhone));
  assert.equal(customer.user.role, 'customer'); assert.equal(customer.user.systemRole, 'USER');
  assert.equal(String(customer.user._id), String(user._id));
  assert.equal((await request('/api/auth/switch-mode', { method: 'POST', token: customer.token, body: { mode: 'admin' } })).status, 403);
  ok(await request('/api/auth/me', { token: customer.token }));
});

test('new owner receives the configured email and privileged session only after real-provider OTP verification', async t => {
  const result = await ownerLogin(t);
  assert.equal(accessLifetime(result.token), 86400);
  assert.equal(result.user.role, 'admin'); assert.equal(result.user.email, ownerEmail);
  assert.equal(result.user.isEmailVerified, false); assert.equal(result.user.systemRole, 'MASTER_OWNER');
  assert.equal(result.user.adminAccessSource, undefined);
  const mode = ok(await request('/api/auth/switch-mode', { method: 'POST', token: result.token, body: { mode: 'admin' } }));
  assert.equal(accessLifetime(mode.token), 86400);
  assert.equal(mode.user.activeMode, 'admin'); assert.equal(mode.user.systemRole, 'MASTER_OWNER');
  ok(await request('/api/admin/orders/admin/all', { token: mode.token }));
  assert.equal(isMasterOwner({ phone: oldPhone, role: 'admin', activeMode: 'admin', systemRole: 'MASTER_OWNER', isPhoneVerified: true, $locals: { masterAuthenticated: true } }), false);
});

test('regular admin OTP login, mode switches and cookie refresh all issue 24-hour access', async () => {
  const phone = '9000000077';
  process.env.ADMIN_PHONE_NUMBERS = `${ownerPhone},${phone}`;
  ok(await request('/api/auth/send-otp', { method: 'POST', body: { phone } }));
  const session = ok(await login(phone));
  assert.equal(session.user.role, 'admin');
  assert.equal(session.user.activeMode, 'customer');
  assert.equal(accessLifetime(session.token), 86400);
  const mode = ok(await request('/api/auth/switch-mode', { method: 'POST', token: session.token, body: { mode: 'admin' } }));
  assert.equal(accessLifetime(mode.token), 86400);
  const refreshed = await request('/api/auth/refresh', {
    method: 'POST', headers: { Cookie: `samira_refresh_token=${mode.refreshToken}` }, body: {},
  });
  const renewed = ok(refreshed);
  assert.equal(accessLifetime(renewed.token), 86400);
  assert.equal(renewed.user.activeMode, 'admin');
  assert.match(refreshed.headers.get('set-cookie'), /HttpOnly/i);
  ok(await request('/api/admin/orders/admin/all', { token: renewed.token }));

  const customerPhone = '9000000078';
  ok(await request('/api/auth/send-otp', { method: 'POST', body: { phone: customerPhone } }));
  const customer = ok(await request('/api/auth/verify-otp', { method: 'POST', body: { phone: customerPhone, otp: '123456', role: 'admin', activeMode: 'admin' } }));
  assert.equal(customer.user.role, 'customer');
  assert.equal(accessLifetime(customer.token), 900);
});

test('an admin access token still works after 23 hours without a refresh cookie, but not after 24 hours', async t => {
  const { user } = await createAdmin();
  function tokenIssuedAt(time) {
    const clock = t.mock.method(Date, 'now', () => time);
    try { return generateToken(user); } finally { clock.mock.restore(); }
  }
  const now = Date.now();
  const activeToken = tokenIssuedAt(now - 23 * 60 * 60 * 1000);
  const expiredToken = tokenIssuedAt(now - 25 * 60 * 60 * 1000);
  ok(await request('/api/auth/me', { token: activeToken }));
  ok(await request('/api/admin/orders/admin/all', { token: activeToken }));
  assert.equal((await request('/api/auth/me', { token: expiredToken })).status, 401);
});

test('logout and blocked accounts reject otherwise valid 24-hour admin access and refresh tokens', async () => {
  for (const action of ['logout', 'block']) {
    const { user, token } = await createAdmin();
    const refreshToken = generateRefreshToken(user);
    assert.equal(accessLifetime(token), 86400);
    if (action === 'logout') ok(await request('/api/auth/logout', { method: 'POST', token, body: {} }));
    else await User.updateOne({ _id: user._id }, { $set: { isBlocked: true } });
    assert.equal((await request('/api/auth/me', { token })).status, 401);
    assert.equal((await request('/api/auth/refresh', {
      method: 'POST', headers: { Cookie: `samira_refresh_token=${refreshToken}` }, body: {},
    })).status, 401);
  }
});

test('configured owner login cannot use the customer mock-OTP path', async () => {
  const sent = await request('/api/auth/send-otp', { method: 'POST', body: { phone: ownerPhone } });
  assert.equal(sent.status, 503); assert.equal(sent.data.demoOtp, undefined);
  assert.notEqual((await login(ownerPhone)).status, 200);
  assert.equal(await User.countDocuments({ phone: ownerPhone }), 0);
});

test('changing an env-granted admin removes old privileges while unrelated manually granted admins are retained', async () => {
  const envAdmin = await createAdmin({ phone: '9000000002', adminAccessSource: 'ENV', availableModes: ['customer', 'admin', 'seller'] });
  const manual = await createAdmin({ adminAccessSource: 'MANUAL' });
  const historical = await createAdmin();
  await reconcileDeploymentAdmins();
  const retired = await User.findById(envAdmin.user._id);
  assert.equal(retired.role, 'customer'); assert.deepEqual([...retired.availableModes], ['customer', 'seller']);
  assert.equal((await User.findById(manual.user._id)).role, 'admin');
  assert.equal((await User.findById(historical.user._id)).role, 'admin');
});

test('owner email collisions do not merge accounts or steal an existing customer email', async t => {
  const customer = await createCustomer({ email: ownerEmail, isEmailVerified: true });
  const result = await ownerLogin(t);
  assert.notEqual(result.user.email, ownerEmail);
  assert.equal((await User.findById(customer.user._id)).email, ownerEmail);
  assert.equal((await User.findById(customer.user._id)).role, 'customer');
});

test('fresh OTP login after logout retains the new auth-session version', async () => {
  const phone = '9000000003';
  ok(await request('/api/auth/send-otp', { method: 'POST', body: { phone } }));
  const first = ok(await login(phone));
  ok(await request('/api/auth/logout', { method: 'POST', token: first.token, body: {} }));
  assert.equal((await request('/api/auth/me', { token: first.token })).status, 401);
  ok(await request('/api/auth/send-otp', { method: 'POST', body: { phone } }));
  const second = ok(await login(phone));
  ok(await request('/api/auth/me', { token: second.token }));
});

test('legacy documents without systemRole are still revoked and concurrent reads only invalidate once', async () => {
  const { user } = await createAdmin({ phone: oldPhone });
  await User.collection.updateOne({ _id: user._id }, { $unset: { systemRole: '' } });
  await Promise.all([reconcileDeploymentAdmins(), reconcileDeploymentAdmins()]);
  const stored = await User.findById(user._id).select('+authSessionVersion');
  assert.equal(stored.role, 'customer'); assert.equal(stored.authSessionVersion, 1);
});

test('owner changes are applied dynamically and a previous owner token loses master and admin access', async t => {
  const result = await ownerLogin(t);
  process.env.ADMIN_PHONE_NUMBERS = '9000000004';
  assert.equal(isOwnerPhone(ownerPhone), false); assert.equal(isOwnerPhone('9000000004'), true);
  assert.equal((await request('/api/auth/me', { token: result.token })).status, 401);
  const previousOwner = await User.findById(result.user._id);
  assert.equal(previousOwner.role, 'customer'); assert.equal(previousOwner.systemRole, 'USER');
});

test('the configured profile email stays unverified until its own email OTP is verified', async () => {
  const { token, user } = await createCustomer({ email: ownerEmail, isEmailVerified: false });
  const sent = ok(await request('/api/auth/profile/send-email-change-otp', { method: 'POST', token, body: { email: ownerEmail } }));
  assert.equal(sent.demoOtp, '123456');
  const proof = ok(await request('/api/auth/profile/verify-email-change-otp', { method: 'POST', token, body: { email: ownerEmail, otp: sent.demoOtp } }));
  const updated = ok(await request('/api/auth/profile', { method: 'PUT', token, body: { name: user.name, phone: user.phone, email: ownerEmail, emailVerificationToken: proof.verificationToken } }));
  assert.equal(updated.isEmailVerified, true);
});
