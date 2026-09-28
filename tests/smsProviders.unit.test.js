const test = require('node:test');
const assert = require('node:assert/strict');
const sms = require('../services/smsService');
const { getAdapter } = require('../services/providers/smsProviderRegistry');

const configurations = {
  twilio: { SMS_ACCOUNT_SID: 'AC-test-account', SMS_AUTH_TOKEN: 'private-test-token', SMS_SENDER_ID: '+15005550006' },
  msg91: { MSG91_AUTH_KEY: 'private-test-key', MSG91_TEMPLATE_ID: 'test-template' },
  '2factor': { TWOFACTOR_API_KEY: 'private-test-key', TWOFACTOR_SMS_SENDER_ID: 'NISHAY', TWOFACTOR_SMS_TEMPLATE: 'Nishaya verification code: {otp}.' },
  fast2sms: { FAST2SMS_API_KEY: 'private-test-key' },
};
const accepted = {
  twilio: { sid: 'SM-test-message', status: 'queued' },
  msg91: { type: 'success', message: 'test-request' },
  '2factor': { Status: 'Success', Details: 'test-session' },
  fast2sms: { return: true, request_id: 'test-request' },
};

test.beforeEach(t => {
  const pattern = /^(SMS_|TWILIO_|MSG91_|TWOFACTOR_|FAST2SMS_|OTP_MODE$|NODE_ENV$)/;
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => pattern.test(key)));
  for (const key of Object.keys(previous)) delete process.env[key];
  Object.assign(process.env, { NODE_ENV: 'production', OTP_MODE: 'production' });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (pattern.test(key)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'info', () => {});
  // Every test must explicitly mock a provider response; never send paid SMS.
  t.mock.method(global, 'fetch', async () => { throw new Error('Unexpected network request'); });
});

function configure(name) { Object.assign(process.env, { SMS_PROVIDER: name, ...configurations[name] }); }
function reply(t, data, status = 200) {
  return t.mock.method(global, 'fetch', async () => ({ ok: status >= 200 && status < 300, status, json: async () => data }));
}

test('every registered provider sends the backend OTP with a timeout and no redirects', async t => {
  for (const name of Object.keys(configurations)) {
    configure(name);
    const fetch = reply(t, accepted[name]);
    assert.equal(sms.getSmsConfiguration().configured, true);
    assert.equal(sms.isRealSmsProvider(name), true);
    const result = await sms.sendOtp('+91 98765 43210', '654321', { requireReal: true });
    assert.equal(result.success, true);
    assert.equal(result.provider, name);
    const [address, options] = fetch.mock.calls[0].arguments;
    const url = new URL(address);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'POST');
    if (name === 'twilio') {
      assert.equal(options.body.get('To'), '+919876543210');
      assert.match(options.body.get('Body'), /654321/);
      assert.equal(options.headers.Authorization, `Basic ${Buffer.from('AC-test-account:private-test-token').toString('base64')}`);
    } else if (name === 'msg91') {
      assert.equal(url.searchParams.get('mobile'), '919876543210');
      assert.equal(url.searchParams.get('otp'), '654321');
      assert.equal(url.searchParams.get('template_id'), 'test-template');
      assert.equal(options.headers.authkey, 'private-test-key');
    } else if (name === '2factor') {
      assert.equal(url.hostname, '2factor.in');
      assert.equal(url.pathname, '/API/R1/');
      assert.equal(options.body.get('module'), 'TRANS_SMS');
      assert.equal(options.body.get('to'), '919876543210');
      assert.equal(options.body.get('msg'), 'Nishaya verification code: 654321.');
      assert.equal(result.channel, 'sms');
    } else {
      assert.equal(JSON.parse(options.body).numbers, '9876543210');
      assert.equal(JSON.parse(options.body).variables_values, '654321');
    }
    assert.equal(fetch.mock.callCount(), 1);
  }
});

test('provider-specific variables override legacy settings; legacy MSG91 and Fast2SMS still work', async t => {
  for (const name of ['msg91', 'fast2sms']) {
    process.env.SMS_PROVIDER = name;
    process.env.SMS_API_KEY = 'legacy-key';
    process.env.SMS_TEMPLATE_ID = 'legacy-template';
    const fetch = reply(t, accepted[name]);
    assert.equal((await sms.sendOtp('9876543210', '654321')).success, true);
    const options = fetch.mock.calls[0].arguments[1];
    assert.equal(options.headers[name === 'msg91' ? 'authkey' : 'authorization'], 'legacy-key');
  }
  configure('twilio');
  Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'AC-specific', TWILIO_AUTH_TOKEN: 'specific-token', TWILIO_SENDER_ID: '+15005550007' });
  const fetch = reply(t, accepted.twilio);
  assert.equal((await sms.sendOtp('9876543210', '654321')).success, true);
  assert.match(fetch.mock.calls[0].arguments[0], /AC-specific/);
  assert.equal(fetch.mock.calls[0].arguments[1].body.get('From'), '+15005550007');
  configure('msg91');
  const msg91Fetch = reply(t, accepted.msg91);
  await sms.sendOtp('9876543210', '654321');
  assert.equal(msg91Fetch.mock.calls[0].arguments[1].headers.authkey, 'private-test-key');
});

test('case and 2Factor aliases select the same SMS-only adapter without a legacy template name', async t => {
  configure('2factor');
  delete process.env.TWOFACTOR_TEMPLATE_NAME;
  for (const name of [' 2FACTOR ', 'twofactor', 'two-factor']) {
    process.env.SMS_PROVIDER = name;
    const fetch = reply(t, accepted['2factor']);
    assert.equal((await sms.sendOtp('9876543210', '654321')).provider, '2factor');
    assert.equal(fetch.mock.calls[0].arguments[0], 'https://2factor.in/API/R1/');
    assert.equal(fetch.mock.calls[0].arguments[1].body.get('module'), 'TRANS_SMS');
  }
});

test('unsupported/missing providers and production mock fail without sending or leaking', async t => {
  const fetch = reply(t, {});
  for (const name of ['', 'mock', 'private-typo', '__proto__', 'constructor']) {
    process.env.SMS_PROVIDER = name;
    assert.deepEqual(await sms.sendOtp('9876543210', '654321'), { success: false, code: 'OTP_PROVIDER_NOT_CONFIGURED' });
    assert.equal(sms.getSmsConfiguration().configured, false);
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.ok(!JSON.stringify(sms.getSmsConfiguration()).includes('private-typo'));
});

test('incomplete credentials never call a provider; 2Factor cannot reuse another provider key', async t => {
  const fetch = reply(t, {});
  for (const name of Object.keys(configurations)) {
    process.env.SMS_PROVIDER = name;
    assert.deepEqual(await sms.sendOtp('9876543210', '654321'), { success: false, code: 'OTP_PROVIDER_NOT_CONFIGURED' });
    assert.ok(sms.getSmsConfiguration().missing.length > 0);
  }
  process.env.SMS_PROVIDER = '2factor'; process.env.SMS_API_KEY = 'another-vendor-secret';
  assert.equal(sms.getSmsConfiguration().configured, false);
  assert.equal(fetch.mock.callCount(), 0);
});

test('local demo stays offline and production-mode local tests require the selected real provider', async t => {
  Object.assign(process.env, { NODE_ENV: 'development', OTP_MODE: 'demo' });
  const fetch = reply(t, accepted['2factor']);
  t.mock.method(console, 'log', () => {});
  configure('2factor');
  assert.equal((await sms.sendOtp('9876543210', '654321')).provider, 'mock');
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal((await sms.sendOtp('9876543210', '654321', { requireReal: true })).provider, '2factor');
  process.env.OTP_MODE = 'production';
  assert.equal((await sms.sendOtp('9876543210', '654321')).provider, '2factor');
  process.env.SMS_PROVIDER = 'mock';
  assert.equal((await sms.sendOtp('9876543210', '654321')).success, false);
});

test('HTTP 200 with application failure, missing status or invalid JSON is never accepted', async t => {
  const failures = {
    twilio: { sid: 'SM-failed', status: 'failed' },
    msg91: { type: 'error', message: 'private-template-data' },
    '2factor': { Status: 'Error', Details: 'private-balance-data' },
    fast2sms: { return: false, message: ['private-balance-data'] },
  };
  for (const name of Object.keys(configurations)) {
    configure(name);
    for (const data of [failures[name], {}, null, []]) {
      reply(t, data);
      assert.deepEqual(await sms.sendOtp('9876543210', '654321'), { success: false, code: 'OTP_DELIVERY_UNAVAILABLE' });
    }
    t.mock.method(global, 'fetch', async () => ({ ok: true, status: 200, json: async () => { throw new Error('private HTML response'); } }));
    assert.equal((await sms.sendOtp('9876543210', '654321')).success, false);
  }
});

test('HTTP authentication errors are safe for every provider, including direct adapter calls', async t => {
  for (const name of Object.keys(configurations)) {
    configure(name);
    reply(t, { message: 'private account data', Details: 'private API key' }, 401);
    await assert.rejects(getAdapter(name).sendOtp('9876543210', '654321'), error => {
      assert.equal(error.errorCode, 'OTP_PROVIDER_AUTH_FAILED');
      assert.ok(!String(error.stack).includes('private'));
      return true;
    });
  }
  configure('2factor'); reply(t, { Status: 'Error', Details: 'Invalid API Key - No Account Exists' });
  assert.equal((await sms.sendOtp('9876543210', '654321')).code, 'OTP_PROVIDER_AUTH_FAILED');
  configure('msg91'); reply(t, { type: 'error', message: 'Invalid authkey' });
  assert.equal((await sms.sendOtp('9876543210', '654321')).code, 'OTP_PROVIDER_AUTH_FAILED');
});

test('network failures/timeouts make one attempt and never fallback or expose secret URLs', async t => {
  for (const name of Object.keys(configurations)) {
    configure(name);
    const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('https://private-key/9876543210/654321'); });
    assert.deepEqual(await sms.sendOtp('9876543210', '654321'), { success: false, code: 'OTP_DELIVERY_UNAVAILABLE' });
    assert.equal(fetch.mock.callCount(), 1);
  }
});

test('country codes are not duplicated and unsupported destinations/invalid OTPs are rejected', async t => {
  for (const name of ['msg91', 'twilio']) {
    configure(name);
    const fetch = reply(t, accepted[name]);
    await sms.sendOtp('+14155552671', '654321');
    const [address, options] = fetch.mock.calls[0].arguments;
    assert.equal(name === 'twilio' ? options.body.get('To') : new URL(address).searchParams.get('mobile'), name === 'twilio' ? '+14155552671' : '14155552671');
  }
  for (const name of ['2factor', 'fast2sms']) {
    configure(name);
    const fetch = reply(t, accepted[name]);
    assert.equal((await sms.sendOtp('+14155552671', '654321')).success, false);
    assert.equal((await sms.sendOtp('bad-number', '654321')).success, false);
    assert.equal((await sms.sendOtp('9876543210', 'AUTOGEN')).success, false);
    assert.equal(fetch.mock.callCount(), 0);
  }
});

test('timeouts are bounded and readiness exposes no credential values', async t => {
  configure('2factor');
  const timeout = t.mock.method(AbortSignal, 'timeout', () => new AbortController().signal);
  reply(t, accepted['2factor']);
  for (const [setting, expected] of [['', 15000], ['invalid', 15000], ['-1', 15000], ['10', 1000], ['90000', 30000], ['5000', 5000]]) {
    process.env.SMS_REQUEST_TIMEOUT_MS = setting;
    await sms.sendOtp('9876543210', '654321');
    assert.equal(timeout.mock.calls.at(-1).arguments[0], expected);
  }
  assert.ok(!JSON.stringify(sms.getSmsConfiguration()).includes('private-test-key'));
});
