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
  '2factor': { env: { TWOFACTOR_API_KEY: 'test-key' }, reply: { Status: 'Success', Details: 'test-session' } },
  '2factor-transactional': {
    provider: '2factor',
    env: { TWOFACTOR_API_KEY: 'test-key', TWOFACTOR_DELIVERY_MODE: 'transactional_sms', TWOFACTOR_SMS_SENDER_ID: 'NISHAY', TWOFACTOR_SMS_TEMPLATE: 'Your verification code is {otp}. Do not share it.' },
    reply: { Status: 'Success', Details: 'test-sms-reference' },
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
        : name === '2factor-transactional' ? options.body.get('msg').match(/\b\d{6}\b/)[0]
          : name === '2factor' ? address.pathname.split('/')[6]
          : JSON.parse(options.body).variables_values;
    if (name === '2factor-transactional') {
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
      assert.equal((await send('resend-otp')).status, 429);
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

test('transactional SMS resend remains SMS, expires the previous code and preserves cooldown and single-use verification', async t => {
  const delivery = mockDelivery(t, '2factor-transactional');
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
