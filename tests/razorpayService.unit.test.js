const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { wrapPaymentHandler } = require('../utils/paymentRouteHandler');
const { verifyRazorpaySignature } = require('../utils/paymentUtils');

// Stub the SDK, not the order service: no actual credentials, network or database.
function loadService({ create, env = {} } = {}) {
  const requests = [];
  const credentials = [];
  class RazorpayStub {
    constructor(options) {
      credentials.push(options);
      this.orders = { create: async body => { requests.push(body); return create ? create(body) : { id: 'order_unit', ...body }; } };
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../services/razorpayService.js'), 'utf8'), {
    module, process: { env: { RAZORPAY_KEY_ID: 'rzp_test_unit', RAZORPAY_KEY_SECRET: 'unit-server-secret', ...env } },
    require: name => name === 'razorpay' ? RazorpayStub : require(name),
  });
  return { service: module.exports, requests, credentials };
}

test('Razorpay SDK receives integer paise, INR, receipt and notes; credentials stay in the SDK', async () => {
  const { service, requests, credentials } = loadService();
  const result = await service.createRazorpayOrder({ amountInPaise: 100, receipt: 'checkout_unit', notes: { purpose: 'checkout' } });
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ amount: 100, currency: 'INR', receipt: 'checkout_unit', notes: { purpose: 'checkout' } }]);
  assert.equal(credentials[0].key_id, 'rzp_test_unit');
  assert.equal(credentials[0].key_secret, 'unit-server-secret');
  assert.equal(JSON.stringify(result).includes('unit-server-secret'), false);
});

test('invalid paise values are refused before calling Razorpay, including in mock mode', async () => {
  for (const mock of [undefined, '1']) {
    const { service, requests, credentials } = loadService({ env: { RAZORPAY_MOCK: mock } });
    for (const amountInPaise of [undefined, null, '100', NaN, Infinity, -100, 0, 99, 100.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(service.createRazorpayOrder({ amountInPaise }), error => error.statusCode === 400 && error.errorCode === 'VALIDATION_ERROR');
    }
    assert.equal(requests.length, 0); assert.equal(credentials.length, 0);
  }
});

test('provider authentication errors return 401 and other provider failures return 500', async () => {
  for (const [providerStatus, expectedStatus] of [[401, 401], [400, 500], [429, 500], [503, 500]]) {
    const { service } = loadService({ create: async () => { throw { statusCode: providerStatus, error: { description: 'Provider rejected the request' } }; } });
    const response = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await wrapPaymentHandler(async () => service.createRazorpayOrder({ amountInPaise: 100, receipt: 'unit' }))({}, response);
    assert.equal(response.statusCode, expectedStatus);
    assert.equal(response.body.success, false);
    assert.equal(JSON.stringify(response.body).includes('unit-server-secret'), false);
  }
});

test('signature helper rejects structured inputs without coercing them', () => {
  for (const field of ['razorpayOrderId', 'razorpayPaymentId', 'razorpaySignature', 'secret']) {
    assert.equal(verifyRazorpaySignature({ razorpayOrderId: 'order_unit', razorpayPaymentId: 'pay_unit', razorpaySignature: '0'.repeat(64), secret: 'unit-secret', [field]: { toString() { throw new Error('must not coerce'); } } }), false);
  }
});
