const test = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('../services/providers/twoFactorProvider');
const sms = require('../services/smsService');
const { getDeliveryReport } = require('../services/providers/twoFactorDeliveryReport');

const apiKey = 'private-mode-test-key';
const phone = '9876543210';
const otp = '654321';
const reference = '11111111-2222-3333-4444-555555555555';
const otpEnv = {
  SMS_PROVIDER: '2factor', OTP_MODE: 'production', NODE_ENV: 'production',
  TWOFACTOR_API_KEY: apiKey, TWOFACTOR_DELIVERY_MODE: 'otp_sms',
  TWOFACTOR_TEMPLATE_NAME: 'NISHAYA_VERIFY', TWOFACTOR_OTP_SMS_ONLY_CONFIRMED: 'true',
};
const transactionalEnv = {
  TWOFACTOR_DELIVERY_MODE: 'transactional_sms',
  TWOFACTOR_SMS_SENDER_ID: 'NISHAY', TWOFACTOR_SMS_TEMPLATE: 'Code {otp}.',
};

test.beforeEach(t => {
  const pattern = /^(SMS_|TWOFACTOR_|OTP_MODE$|NODE_ENV$)/;
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => pattern.test(key)));
  for (const key of Object.keys(previous)) delete process.env[key];
  Object.assign(process.env, otpEnv);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (pattern.test(key)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(global, 'fetch', async () => { throw new Error('Unexpected external request'); });
});

function reply(t, data = { Status: 'Success', Details: reference }, status = 200) {
  return t.mock.method(global, 'fetch', async () => new Response(JSON.stringify(data), { status }));
}

test('otp_sms uses only the approved template name, not transactional sender/content/DLT fields', () => {
  Object.assign(process.env, { TWOFACTOR_SMS_SENDER_ID: 'bad', TWOFACTOR_SMS_TEMPLATE: 'invalid', TWOFACTOR_DLT_ENTITY_ID: 'invalid', TWOFACTOR_DLT_TEMPLATE_ID: 'invalid' });
  const config = sms.getSmsConfiguration();
  assert.equal(config.configured, true);
  assert.equal(config.deliveryMode, 'otp_sms');
  assert.deepEqual(config.supportedDeliveryModes, ['transactional_sms', 'otp_sms']);
  assert.deepEqual(config.invalid, []);
  assert.doesNotMatch(JSON.stringify(config), /private-mode-test-key|NISHAYA_VERIFY/);
  assert.deepEqual(Object.keys(adapter.getConfiguration().values), ['apiKey', 'templateName', 'smsOnlyConfirmed']);
});

test('transactional configuration ignores unrelated OTP template/confirmation settings', () => {
  Object.assign(process.env, transactionalEnv, { TWOFACTOR_TEMPLATE_NAME: '/not-a-template', TWOFACTOR_OTP_SMS_ONLY_CONFIRMED: 'false' });
  assert.equal(sms.getSmsConfiguration().configured, true);
  assert.equal(sms.getSmsConfiguration().deliveryMode, 'transactional_sms');
});

for (const field of ['TWOFACTOR_API_KEY', 'TWOFACTOR_TEMPLATE_NAME', 'TWOFACTOR_OTP_SMS_ONLY_CONFIRMED']) {
  test(`otp_sms without ${field} never sends or falls back`, async t => {
    delete process.env[field];
    const fetch = reply(t);
    assert.equal(sms.getSmsConfiguration().configured, false);
    assert.ok(sms.getSmsConfiguration().missing.includes(field));
    assert.deepEqual(await sms.sendOtp(phone, otp), { success: false, code: 'OTP_PROVIDER_NOT_CONFIGURED' });
    assert.equal(fetch.mock.callCount(), 0);
  });
}

test('SMS-only operator confirmation must be explicit and never changes provider account settings', async t => {
  const fetch = reply(t);
  for (const value of ['false', '0', 'yes', 'disabled', 'private-invalid-value']) {
    process.env.TWOFACTOR_OTP_SMS_ONLY_CONFIRMED = value;
    assert.deepEqual(sms.getSmsConfiguration().invalid, ['TWOFACTOR_OTP_SMS_ONLY_CONFIRMED']);
    assert.equal((await sms.sendOtp(phone, otp)).code, 'OTP_PROVIDER_NOT_CONFIGURED');
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('manual OTP request preserves the backend OTP, international phone and named template; no AUTOGEN or voice fields', async t => {
  const fetch = reply(t, { Status: 'Success', Details: reference, OTP: '123456' });
  const sent = await adapter.sendOtp('+91 98765 43210', otp);
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, `https://2factor.in/API/V1/${apiKey}/SMS/%2B919876543210/${otp}/NISHAYA_VERIFY`);
  assert.equal(options.method, 'GET');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.body, undefined);
  assert.doesNotMatch(url, /AUTOGEN|VOICE|TRANS_SMS/);
  assert.equal(sent.delivery.deliveryMode, 'otp_sms');
  assert.equal(sent.delivery.status, 'accepted');
  assert.equal(sent.delivery.providerReference, reference);
  assert.equal(sent.OTP, undefined);
  assert.equal(sent.otp, undefined);
  assert.equal(fetch.mock.callCount(), 1);
  assert.doesNotMatch(JSON.stringify(console.info.mock.calls), /private-mode-test-key|9876543210|654321|123456|NISHAYA_VERIFY|https:\/\//);
});

test('sms_otp is an alias and case/whitespace normalize without changing the endpoint', async t => {
  for (const mode of ['otp_sms', 'sms_otp', ' OTP_SMS ', ' SMS_OTP ']) {
    process.env.TWOFACTOR_DELIVERY_MODE = mode;
    const fetch = reply(t);
    assert.equal((await adapter.sendOtp(phone, otp)).delivery.deliveryMode, 'otp_sms');
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(fetch.mock.calls[0].arguments[1].method, 'GET');
  }
});

test('mode changes take effect on each request; unknown modes never reuse the previous route', async t => {
  const fetch = reply(t);
  Object.assign(process.env, transactionalEnv);
  assert.equal((await adapter.sendOtp(phone, otp)).delivery.deliveryMode, 'transactional_sms');
  process.env.TWOFACTOR_DELIVERY_MODE = 'otp_sms';
  assert.equal((await adapter.sendOtp(phone, otp)).delivery.deliveryMode, 'otp_sms');
  for (const mode of ['otp', 'voice', 'auto', 'sms_only', '__proto__', 'constructor', 'typo']) {
    process.env.TWOFACTOR_DELIVERY_MODE = mode;
    await assert.rejects(adapter.sendOtp(phone, otp), { errorCode: 'OTP_PROVIDER_NOT_CONFIGURED' });
  }
  process.env.TWOFACTOR_DELIVERY_MODE = 'transactional_sms';
  await adapter.sendOtp(phone, otp);
  assert.deepEqual(fetch.mock.calls.map(call => call.arguments[1].method), ['POST', 'GET', 'POST']);
  assert.equal(fetch.mock.callCount(), 3);
});

test('an in-flight request retains its selected mode in diagnostics after env changes', async t => {
  t.mock.method(global, 'fetch', async () => {
    process.env.TWOFACTOR_DELIVERY_MODE = 'transactional_sms';
    return new Response(JSON.stringify({ Status: 'Success', Details: reference }));
  });
  const sent = await adapter.sendOtp(phone, otp);
  assert.equal(sent.delivery.deliveryMode, 'otp_sms');
  assert.equal(JSON.parse(console.info.mock.calls.at(-1).arguments[0]).deliveryMode, 'otp_sms');
});

test('OTP template names and phone/code inputs cannot inject path segments or switch modes', async t => {
  const fetch = reply(t);
  for (const name of ['../VOICE', 'template?mode=voice', 'template\nname', 'a'.repeat(101)]) {
    process.env.TWOFACTOR_TEMPLATE_NAME = name;
    assert.ok(sms.getSmsConfiguration().invalid.includes('TWOFACTOR_TEMPLATE_NAME'));
    assert.equal((await sms.sendOtp(phone, otp)).success, false);
  }
  process.env.TWOFACTOR_TEMPLATE_NAME = 'NISHAYA_VERIFY';
  for (const [number, code] of [['+14155552671', otp], ['bad', otp], [phone, 'AUTOGEN'], [phone, '1234']]) {
    assert.equal((await sms.sendOtp(number, code)).success, false);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('OTP provider/HTTP/network failures stay safe and never retry with transactional or voice', async t => {
  for (const [data, status] of [
    [{ Status: 'Error', Details: `DLT-CNT-REJECT ${apiKey} ${otp}` }, 200],
    [{ Status: 'Error', Details: `Invalid API Key ${apiKey}` }, 401],
    [null, 200], [{ Status: 'Success', Details: '' }, 200],
    [{ Status: 'Success', Details: reference }, 500],
  ]) {
    const fetch = reply(t, data, status);
    const result = await sms.sendOtp(phone, otp, { requestId: reference });
    assert.equal(result.success, false);
    assert.equal(result.delivery.deliveryMode, 'otp_sms');
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(fetch.mock.calls[0].arguments[1].method, 'GET');
    assert.doesNotMatch(JSON.stringify([result, console.info.mock.calls, console.warn.mock.calls]), /private-mode-test-key|9876543210|654321/);
  }
  const fetch = t.mock.method(global, 'fetch', async url => { throw new Error(url); });
  const result = await sms.sendOtp(phone, otp, { requestId: reference });
  assert.equal(result.delivery.status, 'unknown');
  assert.equal(fetch.mock.callCount(), 1);
  assert.doesNotMatch(JSON.stringify([result, console.info.mock.calls, console.warn.mock.calls]), /private-mode-test-key|9876543210|654321|https:\/\//);
});

test('managed OTP mode never queries the unrelated transactional delivery report endpoint', async t => {
  const fetch = reply(t);
  for (const mode of ['otp_sms', 'sms_otp', 'voice']) {
    process.env.TWOFACTOR_DELIVERY_MODE = mode;
    const result = await getDeliveryReport(reference);
    assert.equal(result.reason, 'REPORT_MODE_UNSUPPORTED');
    assert.equal(result.deliveryStatus, 'unknown');
  }
  assert.equal(fetch.mock.callCount(), 0);
});
