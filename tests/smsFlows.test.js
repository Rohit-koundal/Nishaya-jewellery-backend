const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment, getBaseUrl } = require('./helpers');
const Otp = require('../models/Otp');
const Order = require('../models/Order');
const Configuration = require('../models/MasterConfiguration');
const { createCustomer } = require('./factories');
const { verifyOtpHash, verifyTargetOtp } = require('../services/otpService');
const { sendOrderOtp, verifyOrderOtp } = require('../services/codVerificationService');
const { assertClientHandoverReady } = require('../services/clientHandoverService');
const { MASTER_OWNER_PHONE } = require('../config/masterOwner');

const providers = {
  twilio: { env: { SMS_ACCOUNT_SID: 'AC-test', SMS_AUTH_TOKEN: 'test-token', SMS_SENDER_ID: '+15005550006' }, reply: { sid: 'SM-test', status: 'queued' } },
  msg91: { env: { MSG91_AUTH_KEY: 'test-key', MSG91_TEMPLATE_ID: 'test-template' }, reply: { type: 'success', message: 'test-request' } },
  '2factor': { env: { TWOFACTOR_API_KEY: 'test-key', TWOFACTOR_SMS_SENDER_ID: 'NISHAY', TWOFACTOR_SMS_TEMPLATE: 'Your verification code is {otp}. Do not share it.', TWOFACTOR_DLT_ENTITY_ID: '1234567890123456789', TWOFACTOR_DLT_TEMPLATE_ID: '9876543210987654321' }, reply: { Status: 'Success', Details: '09cfe5b29d000018a3acb36000000001' } },
  '2factor-transactional': {
    provider: '2factor',
    env: { TWOFACTOR_API_KEY: 'test-key', TWOFACTOR_DELIVERY_MODE: 'transactional_sms', TWOFACTOR_SMS_SENDER_ID: 'NISHAY', TWOFACTOR_SMS_TEMPLATE: 'Your verification code is {otp}. Do not share it.', TWOFACTOR_DLT_ENTITY_ID: '1234567890123456789', TWOFACTOR_DLT_TEMPLATE_ID: '9876543210987654321' },
    reply: { Status: 'Success', Details: '09cfe5b29d000018a3acb36000000001' },
  },
  fast2sms: { env: { FAST2SMS_API_KEY: 'test-key' }, reply: { return: true, request_id: 'test-request' } },
};

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async t => {
  await resetDatabase();
  const pattern = /^(SMS_|TWILIO_|MSG91_|TWOFACTOR_|FAST2SMS_|OTP_|NODE_ENV$)/;
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => pattern.test(key)));
  for (const key of Object.keys(previous)) delete process.env[key];
  Object.assign(process.env, { NODE_ENV: 'test', OTP_MODE: 'production', OTP_RESEND_COOLDOWN_SECONDS: '60' });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (pattern.test(key)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'info', () => {});
  // Only the isolated local Express app may receive real network traffic.
  const localFetch = global.fetch;
  t.mock.method(global, 'fetch', (url, options) => {
    if (String(url).startsWith(`${getBaseUrl()}/`)) return localFetch(url, options);
    throw new Error('Unexpected external request in SMS flow test');
  });
});

function mockDelivery(t, name) {
  const provider = providers[name].provider || name;
  Object.assign(process.env, { SMS_PROVIDER: provider, ...providers[name].env });
  const previousFetch = global.fetch;
  const state = { accepted: false, otp: '', count: 0 };
  t.mock.method(global, 'fetch', async (url, options) => {
    if (String(url).startsWith(`${getBaseUrl()}/`)) return previousFetch(url, options);
    const address = new URL(url);
    assert.equal(address.hostname, { twilio: 'api.twilio.com', msg91: 'control.msg91.com', '2factor': '2factor.in', fast2sms: 'www.fast2sms.com' }[provider]);
    state.count += 1;
    state.otp = name === 'twilio' ? options.body.get('Body').match(/\b\d{6}\b/)[0]
      : name === 'msg91' ? address.searchParams.get('otp')
        : provider === '2factor' ? options.body.get('msg').match(/\b\d{6}\b/)[0]
          : JSON.parse(options.body).variables_values;
    if (provider === '2factor') {
      assert.equal(address.pathname, '/API/R1/');
      assert.equal(options.body.get('module'), 'TRANS_SMS');
    }
    assert.match(state.otp, /^\d{6}$/);
    return new Response(JSON.stringify(state.accepted ? providers[name].reply : { message: 'private-account-data' }), { status: state.accepted ? 200 : 401 });
  });
  return state;
}

for (const name of Object.keys(providers)) {
  for (const [role, phone] of [['owner', MASTER_OWNER_PHONE], ['customer', '9876543210']]) {
    test(`${name}: ${role} delivery recovery, cooldown and single-use login survive a provider switch`, async t => {
      const delivery = mockDelivery(t, name);
      const headers = { 'X-Forwarded-For': `192.0.2.${Object.keys(providers).indexOf(name) + 1}` };
      const send = path => request(`/api/auth/${path}`, { method: 'POST', body: { phone }, headers });
      const verify = otp => request('/api/auth/verify-otp', { method: 'POST', body: { phone, otp } });
      const failed = await send('send-otp');
      assert.equal(failed.status, 503);
      assert.equal(failed.data.code, 'OTP_PROVIDER_AUTH_FAILED');
      assert.equal(JSON.stringify(failed.data).includes('private-account-data'), false);
      assert.equal(await Otp.countDocuments({ phone, isUsed: false }), 0);
      assert.equal((await verify(delivery.otp)).status, 400);

      delivery.accepted = true;
      const sent = await send('resend-otp');
      assert.equal(sent.status, 200);
      assert.equal(sent.data.otpMode, 'production');
      for (const key of ['otp', 'demoOtp', 'devOtp', 'token']) assert.equal(sent.data[key], undefined);
      const record = await Otp.findOne({ phone, isUsed: false });
      assert.equal(verifyOtpHash(phone, delivery.otp, record.otpHash), true);
      assert.equal(record.trustedDelivery, role === 'owner');
      assert.equal(record.provider, providers[name].provider || name);
      if (record.provider === '2factor') {
        assert.equal(sent.data.deliveryStatus, 'accepted');
        assert.equal(sent.data.supportReference, record.delivery.supportReference);
        assert.equal(record.delivery.providerReference, providers[name].reply.Details);
        assert.equal(sent.data.providerReference, undefined);
        assert.equal(sent.data.accountFingerprint, undefined);
        assert.match(sent.data.message, /requested/i);
        assert.equal(failed.data.deliveryStatus, 'rejected');
        assert.match(failed.data.supportReference, /^[a-f0-9-]{36}$/);
      }
      assert.ok(sent.data.retryAfter > 0 && sent.data.retryAfter <= 60);
      const cooldown = await send('resend-otp');
      assert.equal(cooldown.status, 429);
      assert.ok(cooldown.data.retryAfter > 0);
      assert.equal((await verify('000000')).status, 400);
      assert.equal((await Otp.findById(record._id)).attempts, 1);

      process.env.SMS_PROVIDER = 'unconfigured-after-send';
      const verified = await verify(delivery.otp);
      assert.equal(verified.status, 200);
      assert.ok(verified.data.token);
      assert.equal(verified.data.user.isPhoneVerified, true);
      assert.equal((await request('/api/auth/me', { token: verified.data.token })).status, 200);
      assert.equal((await verify(delivery.otp)).status, 400);
      assert.equal(delivery.count, 2, 'verification and cooldown must not send extra SMS');
    });
  }

  test(`${name}: COD service invalidates failed delivery, retries and verifies only its order`, async t => {
    const delivery = mockDelivery(t, name);
    const { user } = await createCustomer();
    const order = await Order.create({ user: user._id, paymentMethod: 'COD', orderStatus: 'Pending', codVerification: { required: true, status: 'PENDING' } });
    await assert.rejects(sendOrderOtp({ order, phone: user.phone }), error => error.statusCode === 503 && error.errorCode === 'OTP_PROVIDER_AUTH_FAILED');
    assert.equal(await Otp.countDocuments({ phone: user.phone, isUsed: false }), 0);
    assert.equal((await Order.findById(order._id)).codVerification.deliveryStatus, 'FAILED');
    delivery.accepted = true;
    const sent = await sendOrderOtp({ order, phone: user.phone });
    assert.equal(sent.status, 'PENDING');
    assert.equal(sent.demoOtp, undefined);
    assert.equal((await Order.findById(order._id)).codVerification.deliveryStatus, 'SENT');
    await assert.rejects(verifyTargetOtp(user.phone, delivery.otp, { purpose: 'order_cod_verification', contextId: 'different-order' }), /not found|expired/i);
    await assert.rejects(verifyOrderOtp({ order, phone: user.phone, otp: '000000' }), /Invalid OTP/);
    assert.equal((await Order.findById(order._id)).orderStatus, 'Pending');
    const verified = await verifyOrderOtp({ order, phone: user.phone, otp: delivery.otp });
    assert.equal(verified.orderStatus, 'Confirmed');
    assert.equal(verified.codVerification.status, 'VERIFIED');
    await assert.rejects(verifyTargetOtp(user.phone, delivery.otp, { purpose: 'order_cod_verification', contextId: String(order._id) }), /not found|expired/i);
    assert.equal(delivery.count, 2);
  });
}

test('incomplete legacy 2Factor setup cannot authorize login; adding approved configuration restores SMS sending', async t => {
  const delivery = mockDelivery(t, '2factor');
  delivery.accepted = true;
  delete process.env.TWOFACTOR_SMS_SENDER_ID;
  delete process.env.TWOFACTOR_SMS_TEMPLATE;
  process.env.TWOFACTOR_TEMPLATE_NAME = 'Legacy OTP';
  const phone = '9876543210';
  const failed = await request('/api/auth/send-otp', { method: 'POST', body: { phone } });
  assert.equal(failed.status, 503);
  assert.equal(failed.data.code, 'OTP_PROVIDER_NOT_CONFIGURED');
  assert.equal(delivery.count, 0);
  assert.equal(await Otp.countDocuments({ phone, isUsed: false }), 0);
  const denied = await request('/api/auth/verify-otp', { method: 'POST', body: { phone, otp: '123456' } });
  assert.equal(denied.status, 400);
  Object.assign(process.env, providers['2factor'].env);
  const sent = await request('/api/auth/resend-otp', { method: 'POST', body: { phone } });
  assert.equal(sent.status, 200);
  assert.equal(delivery.count, 1);
  const verified = await request('/api/auth/verify-otp', { method: 'POST', body: { phone, otp: delivery.otp } });
  assert.equal(verified.status, 200);
});

test('SMS login without optional DLT IDs still requires provider acceptance and the actual OTP', async t => {
  const delivery = mockDelivery(t, '2factor');
  delete process.env.TWOFACTOR_DLT_ENTITY_ID;
  delete process.env.TWOFACTOR_DLT_TEMPLATE_ID;
  const phone = '9876543200';
  const rejected = await request('/api/auth/send-otp', { method: 'POST', body: { phone } });
  assert.equal(rejected.status, 503);
  assert.equal(await Otp.countDocuments({ phone, isUsed: false }), 0);
  delivery.accepted = true;
  const sent = await request('/api/auth/resend-otp', { method: 'POST', body: { phone } });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.deliveryStatus, 'accepted');
  assert.equal(delivery.count, 2);
  assert.equal((await request('/api/auth/verify-otp', { method: 'POST', body: { phone, otp: delivery.otp } })).status, 200);
});

test('transactional SMS resend remains SMS, expires the previous code and preserves cooldown and single-use verification', async t => {
  const delivery = mockDelivery(t, '2factor-transactional');
  delete process.env.TWOFACTOR_DLT_ENTITY_ID;
  delete process.env.TWOFACTOR_DLT_TEMPLATE_ID;
  delivery.accepted = true;
  const phone = '9876543210';
  let generated = 0;
  t.mock.method(require('node:crypto'), 'randomInt', () => [654321, 123456][generated++]);
  const send = path => request(`/api/auth/${path}`, { method: 'POST', body: { phone } });
  const verify = otp => request('/api/auth/verify-otp', { method: 'POST', body: { phone, otp } });
  assert.equal((await send('send-otp')).status, 200);
  const previousOtp = delivery.otp;
  assert.equal((await send('resend-otp')).status, 429);
  assert.equal(delivery.count, 1);
  // Advance eligibility in the isolated test configuration, not with a real wait.
  process.env.OTP_RESEND_COOLDOWN_SECONDS = '0';
  assert.equal((await send('resend-otp')).status, 200);
  assert.notEqual(delivery.otp, previousOtp);
  assert.equal((await verify(previousOtp)).status, 400);
  assert.equal((await verify(delivery.otp)).status, 200);
  assert.equal((await verify(delivery.otp)).status, 400);
  assert.equal(delivery.count, 2);
});

test('client handover recognizes all configured providers and still requires locked production configuration', async () => {
  process.env.NODE_ENV = 'production';
  for (const [name, provider] of Object.entries(providers)) {
    Object.assign(process.env, { SMS_PROVIDER: provider.provider || name, ...provider.env });
    await assert.doesNotReject(assertClientHandoverReady());
    for (const key of Object.keys(provider.env)) delete process.env[key];
    await assert.rejects(assertClientHandoverReady(), /production OTP mode and a real SMS provider/);
  }
  Object.assign(process.env, { SMS_PROVIDER: '2factor', ...providers['2factor'].env, OTP_MODE: 'demo' });
  await assert.rejects(assertClientHandoverReady(), /production OTP mode/);
  process.env.OTP_MODE = 'production';
  await Configuration.create({ _id: 'store', locked: false });
  await assert.rejects(assertClientHandoverReady(), /Lock the configuration/);
});

test('parallel customer OTP verification succeeds only once', async t => {
  const delivery = mockDelivery(t, '2factor');
  delivery.accepted = true;
  const phone = '9876543210';
  assert.equal((await request('/api/auth/send-otp', { method: 'POST', body: { phone } })).status, 200);
  const results = await Promise.all([1, 2].map(() => request('/api/auth/verify-otp', { method: 'POST', body: { phone, otp: delivery.otp } })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  assert.equal(delivery.count, 1);
});
