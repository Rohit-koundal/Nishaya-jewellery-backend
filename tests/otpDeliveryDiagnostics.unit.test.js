const test = require('node:test');
const assert = require('node:assert/strict');
const sms = require('../services/smsService');
const adapter = require('../services/providers/twoFactorProvider');
const { accountFingerprint, safeProviderReference, publicDelivery } = require('../services/otpDeliveryDiagnostics');
const { getDeliveryReport, parseDeliveryReport } = require('../services/providers/twoFactorDeliveryReport');

const reference = '09cfe5b29d000018a3acb36000000001';
const requestId = '01564fe1-0046-434a-8f91-b4c6c8549a3f';
const apiKey = 'private-diagnostic-unit-key';
const phone = '9876543210';
const otp = '654321';
const valid = { SMS_PROVIDER: '2factor', OTP_MODE: 'production', NODE_ENV: 'production', TWOFACTOR_API_KEY: apiKey, TWOFACTOR_SMS_SENDER_ID: 'NISHAY', TWOFACTOR_SMS_TEMPLATE: 'Verification code {otp}.', TWOFACTOR_DLT_ENTITY_ID: '1234567890123456789', TWOFACTOR_DLT_TEMPLATE_ID: '9876543210987654321' };

test.beforeEach(t => {
  const pattern = /^(SMS_|TWOFACTOR_|OTP_MODE$|NODE_ENV$)/;
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => pattern.test(key)));
  for (const key of Object.keys(previous)) delete process.env[key];
  Object.assign(process.env, valid);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (pattern.test(key)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(global, 'fetch', async () => { throw new Error('Unexpected external request'); });
});

function providerReply(t, details = reference, status = 'Success', httpStatus = 200) {
  return t.mock.method(global, 'fetch', async () => new Response(JSON.stringify({ Status: status, Details: details }), { status: httpStatus }));
}

test('accepted SMS has correlated safe diagnostics, persistent reference and no public provider credentials', async t => {
  const calls = providerReply(t);
  const record = { async save() { this.saved = true; } };
  const sent = await sms.sendOtp(phone, otp, { requestId, record });
  assert.equal(sent.success, true);
  assert.equal(sent.delivery.status, 'accepted');
  assert.equal(sent.delivery.providerReference, reference);
  assert.equal(sent.delivery.accountFingerprint, accountFingerprint(apiKey));
  assert.equal(record.saved, true);
  assert.deepEqual(record.delivery, sent.delivery);
  assert.deepEqual(publicDelivery(sent.delivery), { supportReference: sent.delivery.supportReference, deliveryStatus: 'accepted' });
  const diagnostic = JSON.parse(console.info.mock.calls.at(-1).arguments[0]);
  assert.equal(diagnostic.requestId, requestId);
  assert.equal(diagnostic.event, 'otp.delivery');
  assert.equal(diagnostic.httpStatus, 200);
  assert.equal(diagnostic.supportReference, sent.delivery.supportReference);
  assert.doesNotMatch(JSON.stringify([diagnostic, record.delivery]), /private-diagnostic-unit-key|9876543210|654321|Verification code/);
  assert.equal(calls.mock.callCount(), 1);
});

test('sender/template, DLT, balance, inactive service and rate limiting get safe operator reasons', async t => {
  for (const [details, reason, httpStatus] of [
    ['Sender id not approved', 'SENDER_NOT_APPROVED', 400],
    ['Content template mismatch', 'TEMPLATE_REJECTED', 400],
    ['DLT-CNT-REJECT', 'DLT_CONTENT_REJECTED', 200],
    ['PE-TM chain mapping required', 'DLT_CONFIGURATION', 400],
    ['Balance too low', 'INSUFFICIENT_BALANCE', 400],
    ['Account disabled', 'SERVICE_INACTIVE', 400],
    ['Too many requests', 'PROVIDER_RATE_LIMIT', 429],
    ['Invalid API Key', 'AUTH_OR_PERMISSION', 401],
  ]) {
    const fetch = providerReply(t, `${details}: ${apiKey} ${phone} ${otp}`, 'Error', httpStatus);
    const result = await sms.sendOtp(phone, otp, { requestId });
    assert.equal(result.success, false);
    assert.equal(result.delivery.status, 'rejected');
    assert.equal(result.delivery.reason, reason);
    assert.equal(fetch.mock.callCount(), 1);
    const diagnostic = JSON.parse(console.info.mock.calls.at(-1).arguments[0]);
    assert.equal(diagnostic.providerStatus, 'Error');
    assert.equal(diagnostic.providerDetails, details);
    assert.equal(diagnostic.providerDetailsRedacted, true);
    assert.doesNotMatch(JSON.stringify([result, console.info.mock.calls]), /private-diagnostic-unit-key|9876543210|654321/);
  }
});

test('DLT rejection evidence is internal, sanitized and never considered accepted, even with HTTP 200', async t => {
  for (const status of ['Error', 'Success']) {
    const fetch = t.mock.method(global, 'fetch', async () => new Response(JSON.stringify({
      Status: status, Details: `DLT-CNT-REJECT: ${apiKey} ${phone} ${otp}`,
      apikey: apiKey, msg: `Verification code ${otp}`, unexpected: { private: apiKey },
    })));
    const result = await sms.sendOtp(phone, otp, { requestId });
    assert.equal(result.success, false);
    assert.equal(result.delivery.status, 'rejected');
    assert.equal(result.delivery.reason, 'DLT_CONTENT_REJECTED');
    const diagnostic = JSON.parse(console.info.mock.calls.at(-1).arguments[0]);
    assert.equal(diagnostic.httpStatus, 200);
    assert.equal(diagnostic.providerStatus, status);
    assert.equal(diagnostic.providerCode, 'DLT-CNT-REJECT');
    assert.equal(diagnostic.providerDetails, 'DLT-CNT-REJECT');
    assert.equal(diagnostic.providerDetailsRedacted, true);
    assert.equal(publicDelivery(result.delivery).providerCode, undefined);
    assert.doesNotMatch(JSON.stringify([result, console.info.mock.calls]), /private-diagnostic-unit-key|9876543210|654321|unexpected|Verification code/);
    assert.equal(fetch.mock.callCount(), 1);
  }
});

test('unknown provider text, nested payloads and spoofed status fields are not dumped into logs', async t => {
  for (const details of [`Unrecognized failure ${apiKey} ${otp}`, { Status: 'Error', Details: apiKey }, null]) {
    providerReply(t, details, `Error ${apiKey} ${otp}`);
    await sms.sendOtp(phone, otp, { requestId });
    const diagnostic = JSON.parse(console.info.mock.calls.at(-1).arguments[0]);
    assert.equal(diagnostic.providerStatus, null);
    assert.equal(diagnostic.providerDetails, null);
    assert.equal(diagnostic.providerDetailsRedacted, true);
    assert.doesNotMatch(JSON.stringify(console.info.mock.calls), /private-diagnostic-unit-key|654321|Unrecognized failure/);
  }
});

test('ambiguous network failure is unknown, never delivered, and never automatically retried', async t => {
  const fetch = t.mock.method(global, 'fetch', async () => { throw new Error(`https://private/${apiKey}/${phone}/${otp}`); });
  const result = await sms.sendOtp(phone, otp, { requestId });
  assert.equal(result.delivery.status, 'unknown');
  assert.equal(result.delivery.reason, 'NETWORK_OR_TIMEOUT');
  assert.equal(result.code, 'OTP_DELIVERY_UNAVAILABLE');
  assert.equal(fetch.mock.callCount(), 1);
  assert.doesNotMatch(JSON.stringify([result, console.info.mock.calls, console.warn.mock.calls]), /private-diagnostic-unit-key|9876543210|654321/);
});

test('arbitrary/secret provider details and untrusted correlation headers never become log IDs', async t => {
  for (const details of [`Sent to ${phone}, OTP ${otp}`, apiKey, 'https://private/?apikey=secret', { key: apiKey }]) {
    providerReply(t, details);
    const result = await sms.sendOtp(phone, otp, { requestId: `bad-${apiKey}-${otp}` });
    if (result.success) assert.equal(result.delivery.providerReference, null);
    const diagnostic = JSON.parse(console.info.mock.calls.at(-1).arguments[0]);
    assert.equal(diagnostic.requestId, undefined);
    assert.doesNotMatch(JSON.stringify([result, diagnostic]), /private-diagnostic-unit-key|9876543210|654321|https:\/\/private/);
  }
  assert.equal(safeProviderReference(reference), reference);
  assert.equal(safeProviderReference(requestId), requestId);
  assert.equal(safeProviderReference(requestId, [requestId]), null);
  assert.equal(safeProviderReference(`aaaaaaaa-bbbb-cccc-dddd-000000${otp}`, [otp]), null);
  assert.equal(accountFingerprint(` ${apiKey} `), accountFingerprint(apiKey));
});

test('a metadata persistence failure neither invalidates acceptance nor sends a duplicate', async t => {
  const fetch = providerReply(t);
  const record = { async save() { throw new Error(`database error ${apiKey}`); } };
  assert.equal((await sms.sendOtp(phone, otp, { record })).success, true);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(JSON.parse(console.info.mock.calls.at(-1).arguments[0]).event, 'otp.delivery_metadata_unavailable');
  assert.doesNotMatch(JSON.stringify(console.info.mock.calls), /private-diagnostic-unit-key|database error/);
});

test('a UUID-shaped API key cannot leak through a spoofed request header or echoed provider reference', async t => {
  process.env.TWOFACTOR_API_KEY = requestId;
  providerReply(t, requestId);
  const sent = await sms.sendOtp(phone, otp, { requestId });
  assert.equal(sent.delivery.providerReference, null);
  assert.equal(sent.delivery.reason, 'REFERENCE_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(console.info.mock.calls), new RegExp(requestId));
});

test('approved 3-6 letter sender headers match the actual provider form', () => {
  for (const sender of ['NIS', 'NISH', 'NISHA', 'NISHAY']) {
    process.env.TWOFACTOR_SMS_SENDER_ID = sender;
    assert.deepEqual(adapter.getConfiguration().invalid, []);
  }
});

function receipt(status = 'DELIVERED', error = '0') {
  return `<sms><smsMeta><smsTo>${phone}</smsTo><msg>${otp}</msg></smsMeta><smsStatus><statusDesc>${status}</statusDesc><statusId>5</statusId></smsStatus><smsError><errorId>${error}</errorId><errorGroupId>0</errorGroupId></smsError></sms>`;
}
function reportXml(...rows) { return `<smsLog><logStatus>Valid</logStatus>${rows.join('')}</smsLog>`; }

test('delivery reports distinguish delivered, pending, failed and unknown without leaking XML fields', () => {
  for (const [raw, expected] of [['DELIVERED', 'delivered'], ['SENT', 'pending'], ['QUEUED', 'pending'], ['UNDELIVERABLE', 'failed'], ['UNRECOGNIZED', 'unknown']]) {
    const parsed = parseDeliveryReport(reportXml(receipt(raw)));
    assert.equal(parsed.deliveryStatus, expected);
    assert.doesNotMatch(JSON.stringify(parsed), /9876543210|654321|smsMeta|msg/);
  }
  assert.equal(parseDeliveryReport(reportXml(receipt(), receipt('QUEUED'))).deliveryStatus, 'pending');
  assert.equal(parseDeliveryReport(reportXml(receipt(), receipt('UNRECOGNIZED'))).deliveryStatus, 'unknown');
  assert.equal(parseDeliveryReport(reportXml(receipt(), receipt('REJECTED', '9'))).deliveryStatus, 'failed');
  assert.equal(parseDeliveryReport(reportXml(receipt(), receipt())).deliveryStatus, 'delivered');
});

test('missing, malformed, oversized and entity-containing reports fail closed as unknown', () => {
  for (const xml of ['', '{}', '<html>Error</html>', '<smsLog><logStatus>Invalid</logStatus></smsLog>', reportXml(), '<smsLog>', '<!DOCTYPE x [<!ENTITY x "secret">]><smsLog>&x;</smsLog>', 'x'.repeat(65537)]) {
    const report = parseDeliveryReport(xml);
    assert.equal(report.deliveryStatus, 'unknown');
    assert.equal(report.reportAvailable, false);
  }
});

test('a later DLT-CNT-REJECT receipt is failed with the exact safe provider code, never unknown or delivered', () => {
  const parsed = parseDeliveryReport(reportXml(receipt('DLT-CNT-REJECT')));
  assert.equal(parsed.deliveryStatus, 'failed');
  assert.equal(parsed.reason, 'DLT_CONTENT_REJECTED');
  assert.equal(parsed.receipts[0].providerCode, 'DLT-CNT-REJECT');
  assert.doesNotMatch(JSON.stringify(parsed), /9876543210|654321/);
  assert.equal(parseDeliveryReport(reportXml(receipt(), receipt('DLT-CNT-REJECT'))).deliveryStatus, 'failed');
});

test('read-only report lookup uses TLS, one bounded GET, no redirects and no SMS endpoint', async t => {
  const fetch = t.mock.method(global, 'fetch', async () => new Response(reportXml(receipt()), { headers: { 'Content-Type': 'application/xml' } }));
  const report = await getDeliveryReport(reference, { expectedAccountFingerprint: accountFingerprint(apiKey) });
  assert.equal(report.deliveryStatus, 'delivered');
  assert.equal(fetch.mock.callCount(), 1);
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, `https://2factor.in/API/V1/${apiKey}/ADDON_SERVICES/RPT/TSMS/${reference}`);
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  assert.doesNotMatch(JSON.stringify(report), /private-diagnostic-unit-key|9876543210|654321/);
});

test('report lookup rejects invalid references, missing credentials and mismatched accounts before network', async t => {
  const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('Should not be called'); });
  assert.equal((await getDeliveryReport('../../another/path')).reason, 'INVALID_REFERENCE');
  assert.equal((await getDeliveryReport(reference, { expectedAccountFingerprint: 'different-account' })).reason, 'ACCOUNT_MISMATCH');
  delete process.env.TWOFACTOR_API_KEY;
  assert.equal((await getDeliveryReport(reference)).reason, 'API_KEY_MISSING');
  assert.equal(fetch.mock.callCount(), 0);
});

test('unavailable/oversized reports do not trigger resends or expose network errors', async t => {
  for (const respond of [
    async () => new Response('private-body', { status: 401 }),
    async () => new Response('private-body', { status: 500 }),
    async () => new Response('x'.repeat(65537)),
    async () => new Response('x', { headers: { 'Content-Length': '1000000' } }),
    async () => { throw new Error(`https://2factor.in/${apiKey}/${phone}`); },
  ]) {
    const fetch = t.mock.method(global, 'fetch', respond);
    const report = await getDeliveryReport(reference);
    assert.equal(report.deliveryStatus, 'unknown');
    assert.equal(report.reportAvailable, false);
    assert.equal(fetch.mock.callCount(), 1);
    assert.doesNotMatch(JSON.stringify(report), /private-body|private-diagnostic-unit-key|9876543210/);
  }
});
