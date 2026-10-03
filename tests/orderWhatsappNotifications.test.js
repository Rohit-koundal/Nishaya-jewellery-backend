const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
require('./catalogTestSetup');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Order = require('../models/Order');
const Delivery = require('../models/OrderNotificationDelivery');
const User = require('../models/User');
const Settings = require('../models/Settings');
const service = require('../services/orderNotificationService');
const whatsapp = require('../services/orderNotificationWhatsapp');
const email = require('../services/emailService');
const { normalizeSettingsUpdates } = require('../services/storeSettingsValidation');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  Object.assign(process.env, {
    WHATSAPP_ACCESS_TOKEN: 'fixture-secret', WHATSAPP_PHONE_NUMBER_ID: '123456789', WHATSAPP_API_VERSION: 'v23.0',
    WHATSAPP_APP_SECRET: 'fixture-app-secret', WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'fixture-verify-token',
    WHATSAPP_CUSTOMER_ORDER_TEMPLATE: 'customer_order', WHATSAPP_ADMIN_ORDER_TEMPLATE: 'admin_order', WHATSAPP_TEMPLATE_LANGUAGE: 'en_US',
    BREVO_API_KEY: 'fixture-brevo', BREVO_SENDER_EMAIL: 'sender@test.local', ADMIN_EMAIL: 'admin@test.local',
  });
  await setSettings({ orderAdminWhatsappEnabled: true, orderCustomerWhatsappEnabled: true, orderNotificationWhatsapp: '+919000000099' });
});

async function fixture(extra = {}) {
  const { user, token } = await createCustomer({ isPhoneVerified: true, isEmailVerified: true });
  const order = await Order.create({ user: user._id, orderNotificationVersion: 2, paymentMethod: 'COD', paymentStatus: 'Pending',
    orderStatus: 'Pending', finalAmount: 599, invoiceNumber: 'NJ-TEST', orderItems: [{ name: 'Hoops', quantity: 1, price: 599 }],
    whatsappNotificationConsent: whatsapp.orderWhatsappConsent(user, true), ...extra });
  return { order, user, token };
}
async function onlyWhatsapp(order, audience = 'ADMIN') {
  await service.queueOrderNotifications(order._id);
  await Delivery.updateMany({ order: order._id, $or: [{ channel: { $ne: 'WHATSAPP' } }, { audience: { $ne: audience } }] }, { $set: { status: 'SKIPPED' } });
  return Delivery.findOne({ order: order._id, channel: 'WHATSAPP', audience });
}
function webhook(job, status, extra = {}, phoneId = '123456789') {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: phoneId }, statuses: [{ id: 'wamid.fixture', status, biz_opaque_callback_data: job.idempotencyKey, ...extra }],
  } }] }] };
}
async function postWebhook(body, valid = true) {
  const signature = crypto.createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(JSON.stringify(body)).digest('hex');
  return request('/api/notifications/whatsapp/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': `sha256=${valid ? signature : '0'.repeat(64)}` } });
}

test('configuration is explicit, redacted and per audience; phone normalization is strict', () => {
  assert.equal(whatsapp.whatsappConfiguration().configured, true);
  delete process.env.WHATSAPP_ADMIN_ORDER_TEMPLATE;
  assert.equal(whatsapp.whatsappConfiguration('CUSTOMER').configured, true);
  assert.deepEqual(whatsapp.whatsappConfiguration().missing, ['WHATSAPP_ADMIN_ORDER_TEMPLATE']);
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'https://evil.test';
  assert.ok(whatsapp.whatsappConfiguration().invalid.includes('WHATSAPP_PHONE_NUMBER_ID'));
  assert.ok(!JSON.stringify(whatsapp.whatsappConfiguration()).includes('fixture-secret'));
  assert.equal(whatsapp.whatsappNumber('+91 90000 00099'), '919000000099');
  assert.equal(whatsapp.whatsappNumber('9000000099'), '919000000099');
  assert.equal(whatsapp.whatsappNumber('abc9000000099'), '');
  assert.equal(whatsapp.orderWhatsappConsent({ isPhoneVerified: true, phone: '9000000099' }, 'true').granted, false);
});

test('both emails and both WhatsApp alerts are queued once, independently, only for new eligible orders', async t => {
  const { order } = await fixture();
  const sent = [], mailed = [];
  t.mock.method(whatsapp, 'sendWhatsappTemplate', async body => { sent.push(body); return { messageId: `wamid.${sent.length}` }; });
  t.mock.method(email, 'sendTransactionalEmail', async body => { mailed.push(body); return { messageId: 'email-id' }; });
  await Promise.all([service.queueOrderNotifications(order._id), service.queueOrderNotifications(order._id)]);
  await service.runOrderNotificationTick(); await service.runOrderNotificationTick();
  assert.equal(await Delivery.countDocuments(), 5);
  assert.equal(sent.length, 2); assert.equal(mailed.length, 2);
  assert.deepEqual(sent.map(body => body.template.name).sort(), ['admin_order', 'customer_order']);
  const { order: old } = await fixture({ orderNotificationVersion: 1 });
  await service.queueOrderNotifications(old._id);
  assert.equal(await Delivery.countDocuments({ order: old._id, channel: 'WHATSAPP' }), 0);
  const { order: online } = await fixture({ paymentMethod: 'UPI' });
  await service.queueOrderNotifications(online._id);
  assert.equal(await Delivery.countDocuments({ order: online._id }), 0);
  await Order.updateOne({ _id: online._id }, { $set: { paymentStatus: 'Paid' } });
  await service.queueOrderNotifications(online._id);
  assert.equal(await Delivery.countDocuments({ order: online._id, channel: 'WHATSAPP', event: 'ORDER_CONFIRMED' }), 2);
});

test('WhatsApp errors never suppress email, and missing email never suppresses WhatsApp', async t => {
  const { order } = await fixture();
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  let mails = 0;
  t.mock.method(email, 'sendTransactionalEmail', async () => { mails++; return {}; });
  await service.runOrderNotificationTick();
  assert.equal(mails, 2);
  assert.equal(await Delivery.countDocuments({ order: order._id, channel: 'WHATSAPP', status: 'BLOCKED' }), 2);
  process.env.WHATSAPP_ACCESS_TOKEN = 'fixture-secret'; delete process.env.BREVO_API_KEY;
  let messages = 0;
  t.mock.method(whatsapp, 'sendWhatsappTemplate', async () => { messages++; return { messageId: 'wamid.fixture' }; });
  await fixture(); await service.runOrderNotificationTick();
  assert.equal(messages, 2); assert.equal(mails, 2);
});

test('no customer opt-in, changed phone, blocked account or disabled channel means no send', async t => {
  let sends = 0;
  t.mock.method(whatsapp, 'sendWhatsappTemplate', async () => { sends++; return {}; });
  for (const scenario of ['no-consent', 'changed-phone', 'blocked', 'disabled']) {
    const { order, user } = await fixture(scenario === 'no-consent' ? { whatsappNotificationConsent: { granted: false } } : {});
    const job = await onlyWhatsapp(order, 'CUSTOMER');
    if (scenario === 'changed-phone') await User.updateOne({ _id: user._id }, { $set: { phone: '9000000018' } });
    if (scenario === 'blocked') await User.updateOne({ _id: user._id }, { $set: { isBlocked: true } });
    if (scenario === 'disabled') await Settings.updateMany({}, { $set: { orderCustomerWhatsappEnabled: false } });
    await service.processNextDelivery();
    assert.equal((await Delivery.findById(job._id)).status, 'SKIPPED');
  }
  assert.equal(sends, 0);
});

test('timeout and expired send lease are uncertain and never automatically resent', async t => {
  let sends = 0;
  t.mock.method(whatsapp, 'sendWhatsappTemplate', async () => { sends++; throw new Error('secret phone not logged'); });
  const { order } = await fixture(); const job = await onlyWhatsapp(order);
  await service.processNextDelivery(); await service.processNextDelivery();
  assert.equal(sends, 1);
  const current = await Delivery.findById(job._id);
  assert.equal(current.status, 'UNCERTAIN'); assert.equal(current.ambiguous, true);
  await Delivery.updateOne({ _id: job._id }, { $set: { status: 'PROCESSING', leaseUntil: new Date(0) } });
  await service.processNextDelivery(); assert.equal(sends, 1);
  assert.equal((await Delivery.findById(job._id)).status, 'UNCERTAIN');
});

test('definite rate rejection retries with a bound; definite auth error blocks with numeric code', async t => {
  let sends = 0;
  const sendMock = t.mock.method(whatsapp, 'sendWhatsappTemplate', async () => { sends++; throw Object.assign(new Error('redacted'), { statusCode: 429, providerCode: 130429 }); });
  const { order } = await fixture(); const job = await onlyWhatsapp(order);
  for (let i = 0; i < 5; i++) {
    await Delivery.updateOne({ _id: job._id }, { $set: { availableAt: new Date(0) } });
    await service.processNextDelivery();
  }
  assert.equal(sends, 5); assert.equal((await Delivery.findById(job._id)).status, 'FAILED');
  sendMock.mock.mockImplementation(async () => { throw Object.assign(new Error('token=secret'), { statusCode: 401, providerCode: 190 }); });
  const other = await fixture(); const authJob = await onlyWhatsapp(other.order);
  await service.processNextDelivery();
  const blocked = await Delivery.findById(authJob._id);
  assert.equal(blocked.status, 'BLOCKED'); assert.equal(blocked.ambiguous, false); assert.equal(blocked.providerErrorCode, 190);
  assert.ok(!JSON.stringify(blocked).includes('token=secret'));
});

test('transport uses approved body parameters, bearer header, timeout and no hidden retry', async t => {
  const { order } = await fixture({ codVerification: { status: 'PENDING' } });
  const template = whatsapp.buildWhatsappMessage(order, 'CUSTOMER', { storeName: 'Nishaya Jewellery' });
  assert.deepEqual(template.components[0].parameters.map(p => p.text), ['Nishaya Jewellery', 'NJ-TEST', 'INR 599.00', 'COD - verification pending; payment due on delivery']);
  let calls = 0;
  t.mock.method(global, 'fetch', async (url, options) => {
    calls++; assert.equal(url, 'https://graph.facebook.com/v23.0/123456789/messages');
    assert.equal(options.headers.Authorization, 'Bearer fixture-secret'); assert.ok(options.signal);
    const body = JSON.parse(options.body);
    assert.equal(body.messaging_product, 'whatsapp'); assert.equal(body.type, 'template'); assert.deepEqual(body.template, template);
    assert.equal(body.to, '919000000099'); assert.equal(body.biz_opaque_callback_data, 'reference');
    return { ok: false, status: 400, json: async () => ({ error: { code: 132001, message: 'secret phone number' } }) };
  });
  await assert.rejects(whatsapp.sendWhatsappTemplate({ to: '919000000099', template, correlation: 'reference' }), e => e.providerCode === 132001 && !e.message.includes('secret'));
  assert.equal(calls, 1);
});

test('signed webhook handles fast delivery, duplicates, out-of-order events and invalid signatures', async t => {
  const { order } = await fixture(); const job = await onlyWhatsapp(order);
  t.mock.method(whatsapp, 'sendWhatsappTemplate', async () => {
    assert.equal((await postWebhook(webhook(job, 'delivered'), false)).status, 401);
    assert.equal((await postWebhook(webhook(job, 'delivered', {}, 'another-sender'))).status, 200);
    assert.equal((await Delivery.findById(job._id)).status, 'PROCESSING');
    assert.equal((await postWebhook(webhook(job, 'delivered'))).status, 200);
    return { messageId: 'wamid.fixture' };
  });
  await service.processNextDelivery();
  assert.equal((await Delivery.findById(job._id)).status, 'DELIVERED');
  await postWebhook(webhook(job, 'sent')); await postWebhook(webhook(job, 'delivered')); await postWebhook(webhook(job, 'failed'));
  assert.equal((await Delivery.findById(job._id)).status, 'DELIVERED');
  await postWebhook(webhook(job, 'read')); await postWebhook(webhook(job, 'delivered'));
  assert.equal((await Delivery.findById(job._id)).status, 'READ');
  assert.equal((await request('/api/notifications/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=fixture-verify-token&hub.challenge=42')).data, 42);
  assert.equal((await request('/api/notifications/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42')).status, 403);
});

test('delivery-failed callback records safe code and late callback resolves uncertain sends', async t => {
  const { order } = await fixture(); const job = await onlyWhatsapp(order);
  t.mock.method(whatsapp, 'sendWhatsappTemplate', async () => { throw new Error('timeout'); });
  await service.processNextDelivery();
  await postWebhook(webhook(job, 'failed', { errors: [{ code: 131026, title: 'contains phone and secret' }] }));
  const failed = await Delivery.findById(job._id);
  assert.equal(failed.status, 'FAILED'); assert.equal(failed.providerErrorCode, 131026); assert.equal(failed.ambiguous, false);
  assert.ok(!JSON.stringify(failed).includes('contains phone'));
  await postWebhook(webhook(job, 'delivered')); assert.equal((await Delivery.findById(job._id)).status, 'DELIVERED');
});

test('consent is captured for COD and online without changing replay identity or exposing consent snapshots', async () => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_fixture'; process.env.RAZORPAY_KEY_SECRET = 'test_razorpay_secret';
  await setSettings({ smartCodVerificationEnabled: false, codConfirmationRequired: false, razorpayEnabled: true, upiEnabled: true });
  const { user, token } = await createCustomer({ isPhoneVerified: true });
  const product = await createProduct({ stock: 10 });
  for (const method of ['COD', 'UPI']) {
    const body = { paymentMethod: method, whatsappOrderUpdates: true, whatsappPhone: '+919999999999', checkoutAttemptId: `fixture_attempt_${method}`,
      orderItems: [{ product: String(product._id), quantity: 1 }], shippingAddress: validAddress() };
    const path = method === 'COD' ? '/api/orders/cod' : '/api/payments/create-order';
    const result = await request(path, { method: 'POST', token, body });
    assert.ok([200, 201].includes(result.status), JSON.stringify(result.data));
    const order = await Order.findOne({ checkoutAttemptId: body.checkoutAttemptId }).select('+whatsappNotificationConsent');
    assert.equal(order.whatsappNotificationConsent.phone, whatsapp.whatsappNumber(user.phone));
    assert.equal(order.whatsappNotificationConsent.granted, true);
    assert.ok(!JSON.stringify(result.data).includes('whatsappNotificationConsent'));
    const replay = await request(path, { method: 'POST', token, body: { ...body, whatsappOrderUpdates: false } });
    assert.ok([200, 201].includes(replay.status));
    assert.equal(await Order.countDocuments({ checkoutAttemptId: body.checkoutAttemptId }), 1);
  }
});

test('settings remain private, admin retries only failed channel and old webhook cannot affect retry', async t => {
  const { token } = await createAdmin();
  const { order } = await fixture(); const job = await onlyWhatsapp(order);
  t.mock.method(whatsapp, 'sendWhatsappTemplate', async () => { throw Object.assign(new Error('no access'), { statusCode: 401 }); });
  await service.processNextDelivery();
  delete process.env.BREVO_API_KEY;
  const status = await request('/api/admin/settings/order-notifications', { token });
  assert.equal(status.data.configured, false); assert.equal(status.data.whatsapp.configured, true);
  assert.equal(status.data.whatsapp.adminRecipient, 'Ending 0099');
  assert.ok(!JSON.stringify(status.data).includes('fixture-secret'));
  assert.equal((await request(`/api/admin/settings/order-notifications/${job._id}/retry`, { method: 'POST', token })).status, 200);
  await postWebhook(webhook(job, 'delivered'));
  assert.equal((await Delivery.findById(job._id)).status, 'QUEUED');
  const publicSettings = await request('/api/settings');
  assert.equal(publicSettings.data.orderNotificationWhatsapp, undefined);
  assert.equal((await request('/api/settings/payment-methods')).data.notifications.whatsappAvailable, true);
  assert.throws(() => normalizeSettingsUpdates({ storeName: 'Test', orderAdminWhatsappEnabled: true, orderNotificationWhatsapp: '' }), /WhatsApp number/);
  assert.throws(() => normalizeSettingsUpdates({ storeName: 'Test', orderCustomerWhatsappEnabled: 'true' }), /enabled or disabled/);
});
