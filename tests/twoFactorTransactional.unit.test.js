const test = require('node:test');
const assert = require('node:assert/strict');
const sms = require('../services/smsService');
const adapter = require('../services/providers/twoFactorProvider');

const valid = {
  SMS_PROVIDER: '2factor', NODE_ENV: 'production', OTP_MODE: 'production',
  TWOFACTOR_DELIVERY_MODE: 'transactional_sms', TWOFACTOR_API_KEY: 'private-unit-key',
  TWOFACTOR_SMS_SENDER_ID: 'NISHAY', TWOFACTOR_SMS_TEMPLATE: 'Nishaya verification code: {otp}. Do not share it.',
};
const accepted = { Status: 'Success', Details: '09cfe5b29d000018a3acb36000000001' };

test.beforeEach(t => {
  const pattern = /^(SMS_|TWOFACTOR_|OTP_MODE$|NODE_ENV$)/;
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => pattern.test(key)));
  for (const key of Object.keys(previous)) delete process.env[key];
  Object.assign(process.env, valid);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (pattern.test(key)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'info', () => {});
  // Never use real account credentials, network requests, or paid SMS in tests.
  t.mock.method(global, 'fetch', async () => { throw new Error('Unexpected external request'); });
});

function mockReply(t, data = accepted, status = 200) {
  return t.mock.method(global, 'fetch', async () => ({ ok: status >= 200 && status < 300, status, json: async () => data }));
}

test('transactional mode sends only TRANS_SMS with the exact backend OTP and DLT metadata', async t => {
  process.env.TWOFACTOR_DLT_ENTITY_ID = '1234567890123456789';
  process.env.TWOFACTOR_DLT_TEMPLATE_ID = '9876543210987654321';
  process.env.TWOFACTOR_TEMPLATE_NAME = 'unused-legacy-template';
  const fetch = mockReply(t);
  const sent = await sms.sendOtp('+91 98765 43210', '654321', { requireReal: true });
  assert.equal(sent.success, true);
  assert.equal(sent.provider, '2factor');
  assert.equal(sent.channel, 'sms');
  assert.equal(sent.delivery.status, 'accepted');
  assert.equal(sent.delivery.providerReference, accepted.Details);
  assert.equal(fetch.mock.callCount(), 1);
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, 'https://2factor.in/API/R1/');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(options.body), {
    module: 'TRANS_SMS', apikey: 'private-unit-key', to: '919876543210', from: 'NISHAY',
    msg: 'Nishaya verification code: 654321. Do not share it.',
    peid: '1234567890123456789', ctid: '9876543210987654321',
  });
  assert.ok(!url.includes('private-unit-key'));
});

test('template punctuation, Unicode and whitespace are preserved; no auto-generation or scheduling fields', async t => {
  const template = '  Nishaya & Co.\nCode: {otp}; 100% private + सुरक्षित.  ';
  process.env.TWOFACTOR_SMS_TEMPLATE = template;
  const fetch = mockReply(t);
  assert.equal((await sms.sendOtp('9198765432', '123456')).success, true);
  const body = new URLSearchParams(String(fetch.mock.calls[0].arguments[1].body));
  assert.equal(body.get('msg'), template.replace('{otp}', '123456'));
  assert.equal(body.get('to'), '919198765432', 'A subscriber number starting with 91 retains all ten digits');
  assert.deepEqual([...body.keys()], ['module', 'apikey', 'to', 'from', 'msg']);
});

test('unset, blank and explicit transactional mode only use TRANS_SMS, never the old OTP route', async t => {
  for (const mode of [undefined, '', '  ', 'transactional_sms', ' TRANSACTIONAL_SMS ']) {
    if (mode === undefined) delete process.env.TWOFACTOR_DELIVERY_MODE;
    else process.env.TWOFACTOR_DELIVERY_MODE = mode;
    process.env.TWOFACTOR_TEMPLATE_NAME = 'Ignored Legacy Template';
    const fetch = mockReply(t);
    assert.equal((await sms.sendOtp('9876543210', '654321')).success, true);
    assert.equal(fetch.mock.calls[0].arguments[0], 'https://2factor.in/API/R1/');
    assert.equal(fetch.mock.calls[0].arguments[1].body.get('module'), 'TRANS_SMS');
    assert.equal(sms.getSmsConfiguration().deliveryMode, 'transactional_sms');
    assert.equal(fetch.mock.callCount(), 1);
  }
});

test('legacy OTP, voice and unknown modes fail closed, never returning to the removed route', async t => {
  const fetch = mockReply(t);
  for (const mode of ['otp', ' OTP ', 'sms_otp', 'voice', 'auto', 'sms_only', 'transactional-smss', 'private-invalid-value']) {
    process.env.TWOFACTOR_DELIVERY_MODE = mode;
    const configuration = sms.getSmsConfiguration();
    assert.equal(configuration.configured, false);
    assert.equal(configuration.deliveryMode, 'invalid');
    assert.deepEqual(configuration.invalid, ['TWOFACTOR_DELIVERY_MODE']);
    assert.ok(!JSON.stringify(configuration).includes('private-'));
    assert.deepEqual(await sms.sendOtp('9876543210', '654321'), { success: false, code: 'OTP_PROVIDER_NOT_CONFIGURED' });
  }
  assert.equal(fetch.mock.callCount(), 0);
  process.env.TWOFACTOR_DELIVERY_MODE = ' TRANSACTIONAL_SMS ';
  assert.equal((await sms.sendOtp('9876543210', '654321')).success, true);
  assert.equal(fetch.mock.calls[0].arguments[0], 'https://2factor.in/API/R1/');
});

test('old API-key/template-name configuration cannot send, and diagnostics identify the new required fields', async t => {
  delete process.env.TWOFACTOR_DELIVERY_MODE;
  delete process.env.TWOFACTOR_SMS_SENDER_ID;
  delete process.env.TWOFACTOR_SMS_TEMPLATE;
  process.env.TWOFACTOR_TEMPLATE_NAME = 'Legacy OTP Template';
  const fetch = mockReply(t);
  const configuration = sms.getSmsConfiguration();
  assert.equal(configuration.deliveryMode, 'transactional_sms');
  assert.equal(configuration.configured, false);
  assert.deepEqual(configuration.missing, ['TWOFACTOR_SMS_SENDER_ID', 'TWOFACTOR_SMS_TEMPLATE']);
  assert.deepEqual(await sms.sendOtp('9876543210', '654321'), { success: false, code: 'OTP_PROVIDER_NOT_CONFIGURED' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('the pre-request log contains only the fixed route, never secrets, OTP or recipient', async t => {
  const log = t.mock.method(console, 'info', () => {});
  const fetch = t.mock.method(global, 'fetch', async () => {
    assert.equal(log.mock.callCount(), 1, 'Diagnostic is emitted before the provider request');
    return { ok: true, status: 200, json: async () => accepted };
  });
  await sms.sendOtp('9876543210', '654321');
  assert.deepEqual(log.mock.calls[0].arguments, ['[2Factor] deliveryMode:', 'transactional_sms']);
  const diagnostic = JSON.parse(log.mock.calls[1].arguments[0]);
  assert.equal(diagnostic.status, 'accepted');
  assert.equal(diagnostic.providerReference, accepted.Details);
  assert.doesNotMatch(JSON.stringify(log.mock.calls), /private-unit-key|9876543210|654321/);
  assert.equal(fetch.mock.callCount(), 1);
});

for (const field of ['TWOFACTOR_API_KEY', 'TWOFACTOR_SMS_SENDER_ID', 'TWOFACTOR_SMS_TEMPLATE']) {
  test(`missing ${field} blocks transactional requests before any send`, async t => {
    const fetch = mockReply(t);
    process.env[field] = '   ';
    const configuration = sms.getSmsConfiguration();
    assert.equal(configuration.configured, false);
    assert.ok(configuration.missing.includes(field));
    assert.deepEqual(await sms.sendOtp('9876543210', '654321'), { success: false, code: 'OTP_PROVIDER_NOT_CONFIGURED' });
    assert.equal(fetch.mock.callCount(), 0);
  });
}

test('unresolved/multiple placeholders, invalid sender and invalid DLT IDs cannot appear ready or be sent', async t => {
  const fetch = mockReply(t);
  const invalid = [
    ['TWOFACTOR_SMS_TEMPLATE', 'No code here'], ['TWOFACTOR_SMS_TEMPLATE', 'Code {#var#}'],
    ['TWOFACTOR_SMS_TEMPLATE', '{otp} {otp}'], ['TWOFACTOR_SMS_TEMPLATE', '{otp} for {name}'],
    ['TWOFACTOR_SMS_TEMPLATE', '{{otp}}'], ['TWOFACTOR_SMS_SENDER_ID', 'VM-NISHAY'],
    ['TWOFACTOR_SMS_TEMPLATE', '{otp} for #VAR2#'], ['TWOFACTOR_SMS_SENDER_ID', 'NI'],
    ['TWOFACTOR_SMS_SENDER_ID', 'NISHAYA'],
    ['TWOFACTOR_DLT_ENTITY_ID', 'not-an-id'], ['TWOFACTOR_DLT_TEMPLATE_ID', 'bad-id'],
  ];
  for (const [field, value] of invalid) {
    const previous = process.env[field];
    process.env[field] = value;
    assert.equal(sms.getSmsConfiguration().configured, false);
    assert.ok(sms.getSmsConfiguration().invalid.includes(field));
    assert.deepEqual(await sms.sendOtp('9876543210', '654321'), { success: false, code: 'OTP_PROVIDER_NOT_CONFIGURED' });
    if (previous === undefined) delete process.env[field]; else process.env[field] = previous;
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('safe readiness reports the selected route and field names without exposing any configured values', () => {
  const configuration = sms.getSmsConfiguration();
  assert.equal(configuration.configured, true);
  assert.equal(configuration.deliveryMode, 'transactional_sms');
  assert.deepEqual(configuration.missing, []);
  assert.deepEqual(configuration.invalid, []);
  for (const field of ['TWOFACTOR_API_KEY', 'TWOFACTOR_SMS_SENDER_ID', 'TWOFACTOR_SMS_TEMPLATE']) {
    assert.ok(!JSON.stringify(configuration).includes(process.env[field]));
  }
});

test('HTTP/application errors, invalid JSON and malformed success never trigger OTP, voice or cross-provider fallback', async t => {
  for (const [data, status, code] of [
    [{ Status: 'Error', Details: 'private-provider-text' }, 200, 'OTP_DELIVERY_UNAVAILABLE'],
    [{ Status: 'Error', Details: 'Invalid API Key' }, 200, 'OTP_PROVIDER_AUTH_FAILED'],
    [{}, 401, 'OTP_PROVIDER_AUTH_FAILED'], [{}, 403, 'OTP_PROVIDER_AUTH_FAILED'],
    [{}, 429, 'OTP_DELIVERY_UNAVAILABLE'], [accepted, 500, 'OTP_DELIVERY_UNAVAILABLE'],
    [null, 200, 'OTP_DELIVERY_UNAVAILABLE'], [{ Status: 'Success', Details: '' }, 200, 'OTP_DELIVERY_UNAVAILABLE'],
    [{ Status: 'Success', Details: {} }, 200, 'OTP_DELIVERY_UNAVAILABLE'],
  ]) {
    const fetch = mockReply(t, data, status);
    assert.deepEqual(await sms.sendOtp('9876543210', '654321'), { success: false, code });
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(fetch.mock.calls[0].arguments[0], 'https://2factor.in/API/R1/');
  }
  const fetch = t.mock.method(global, 'fetch', async () => ({ ok: true, status: 200, json: async () => { throw new Error('private HTML'); } }));
  assert.equal((await sms.sendOtp('9876543210', '654321')).code, 'OTP_DELIVERY_UNAVAILABLE');
  assert.equal(fetch.mock.callCount(), 1);
});

test('timeout makes one attempt without exposing message/key and keeps the existing timeout limit', async t => {
  const timeout = t.mock.method(AbortSignal, 'timeout', () => new AbortController().signal);
  const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('private-unit-key 9876543210 654321'); });
  const log = t.mock.method(console, 'warn', () => {});
  await assert.rejects(adapter.sendOtp('9876543210', '654321'), error => {
    assert.equal(error.errorCode, 'OTP_DELIVERY_UNAVAILABLE');
    assert.doesNotMatch(String(error.stack), /private-unit-key|9876543210|654321/);
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(timeout.mock.calls[0].arguments[0], 15000);
  assert.equal((await sms.sendOtp('9876543210', '654321')).success, false);
  assert.equal(fetch.mock.callCount(), 2, 'Each explicit send makes one request, not an automatic retry');
  assert.doesNotMatch(JSON.stringify(log.mock.calls), /private-unit-key|9876543210|654321/);
});

test('transactional route preserves recipient and six-digit-code validation', async t => {
  const fetch = mockReply(t);
  for (const [phone, otp] of [['+14155552671', '654321'], ['bad', '654321'], ['9876543210', 'AUTOGEN'], ['9876543210', '1234']]) {
    assert.equal((await sms.sendOtp(phone, otp)).success, false);
  }
  assert.equal(fetch.mock.callCount(), 0);
});
