const test = require('node:test');
const assert = require('node:assert/strict');
require('./catalogTestSetup');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Order = require('../models/Order');
const Delivery = require('../models/OrderNotificationDelivery');
const Notification = require('../models/Notification');
const Settings = require('../models/Settings');
const Store = require('../models/Store');
const { ensureDefaultStore } = require('../services/storeService');
const service = require('../services/orderNotificationService');
const email = require('../services/emailService');
const { buildOrderEmail, notificationSettings } = require('../services/orderNotificationEmail');
const controller = require('../controllers/orderNotificationController');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  Object.assign(process.env, { BREVO_API_KEY: 'fixture-not-a-real-key', BREVO_SENDER_EMAIL: 'sender@test.local', ADMIN_EMAIL: 'owner@test.local', FRONTEND_URL: 'https://shop.test' });
});

async function fixture(extra = {}, verified = true) {
  const { user } = await createCustomer({ isEmailVerified: verified });
  const order = await Order.create({ user: user._id, orderNotificationVersion: 1, paymentMethod: 'COD', paymentStatus: 'Pending', orderStatus: 'Pending', finalAmount: 599, invoiceNumber: 'NJ-TEST', orderItems: [{ name: 'Gold hoops', quantity: 2, price: 299 }], ...extra });
  return { order, user };
}
async function onlyEmail(order, audience = 'ADMIN') {
  await service.queueOrderNotifications(order._id);
  await Delivery.updateMany({ order: order._id, audience: { $ne: audience } }, { $set: { status: 'SKIPPED' } });
  return Delivery.findOne({ order: order._id, audience });
}
async function dueAgain(id) {
  await Delivery.updateOne({ _id: id }, { $set: { availableAt: new Date(0) } });
}

test('COD booking persists recovery marker and succeeds with email provider unconfigured', async () => {
  delete process.env.BREVO_API_KEY;
  await setSettings({ smartCodVerificationEnabled: false, codConfirmationRequired: false });
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 4 });
  const result = await request('/api/orders/cod', { method: 'POST', token, body: { paymentMethod: 'COD', orderItems: [{ product: String(product._id), quantity: 1 }], shippingAddress: validAddress() } });
  assert.equal(result.status, 201);
  const order = await Order.findById(result.data._id);
  assert.equal(order.orderNotificationVersion, 2);
  await service.runOrderNotificationTick();
  assert.equal((await Delivery.findOne({ order: order._id, audience: 'ADMIN' })).status, 'BLOCKED');
  assert.equal((await Delivery.findOne({ order: order._id, channel: 'IN_APP' })).status, 'SENT');
});

test('concurrent enqueue/worker calls make one customer email, one admin email and deduplicated inbox alerts', async t => {
  const { order, user } = await fixture();
  const { user: admin } = await createAdmin();
  const sent = [];
  t.mock.method(email, 'sendTransactionalEmail', async payload => { sent.push(payload); return { messageId: 'provider-id' }; });
  await Promise.all([service.queueOrderNotifications(order._id), service.queueOrderNotifications(order._id)]);
  assert.equal(await Delivery.countDocuments(), 3);
  await Promise.all(Array.from({ length: 6 }, () => service.processNextDelivery()));
  await service.queueOrderNotifications(order._id);
  await service.runOrderNotificationTick();
  assert.equal(sent.length, 2);
  assert.deepEqual(new Set(sent.map(item => item.to)), new Set(['owner@test.local', user.email]));
  assert.equal(await Notification.countDocuments({ user: user._id, audience: 'CUSTOMER' }), 1);
  assert.equal(await Notification.countDocuments({ user: admin._id, audience: 'ADMIN' }), 1);
  assert.equal(await Delivery.countDocuments({ status: 'ACCEPTED' }), 2);
  assert.equal(await Delivery.countDocuments({ email: { $exists: true } }), 0);
});

test('online orders notify only after Paid; cancelled and historical orders are not backfilled', async t => {
  t.mock.method(email, 'sendTransactionalEmail', async () => ({ messageId: 'id' }));
  const { order } = await fixture({ paymentMethod: 'UPI' });
  await fixture({ orderNotificationVersion: undefined });
  await fixture({ orderStatus: 'Cancelled' });
  await service.recoverOrderNotifications();
  assert.equal(await Delivery.countDocuments(), 0);
  await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: 'Paid', paymentState: 'PAID' } });
  await service.runOrderNotificationTick();
  await service.runOrderNotificationTick();
  assert.equal(await Delivery.countDocuments(), 3);
  assert.equal(await Delivery.countDocuments({ event: 'ORDER_CONFIRMED' }), 3);
});

test('recovery completes partial outbox writes after a restart without extra jobs', async () => {
  const { order } = await fixture();
  await Delivery.create({ dedupeKey: `${order._id}:ORDER_PLACED:IN_APP:ALL`, order: order._id, event: 'ORDER_PLACED', channel: 'IN_APP', audience: 'ALL' });
  await service.recoverOrderNotifications();
  assert.equal(await Delivery.countDocuments(), 3);
  assert.ok((await Order.findById(order._id)).orderNotificationQueuedAt);
});

test('unverified customers retain in-app alerts but are never emailed', async t => {
  const { order } = await fixture({}, false);
  const sent = [];
  t.mock.method(email, 'sendTransactionalEmail', async payload => { sent.push(payload); return {}; });
  await service.runOrderNotificationTick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@test.local');
  assert.equal((await Delivery.findOne({ order: order._id, audience: 'CUSTOMER' })).reason, 'NO_VERIFIED_CUSTOMER_EMAIL');
  assert.equal(await Notification.countDocuments({ audience: 'CUSTOMER' }), 1);
});

test('default-store legacy settings are respected; tenant email never falls back to deployment admin', async () => {
  const store = await ensureDefaultStore();
  await Settings.create({ orderNotificationEmail: 'private@test.local', orderAdminEmailEnabled: false });
  assert.equal((await notificationSettings(store._id)).adminEmail, 'private@test.local');
  assert.equal((await notificationSettings(store._id)).settings.orderAdminEmailEnabled, false);
  const other = await Store.create({ name: 'Other', slug: 'other' });
  assert.equal((await notificationSettings(other._id)).adminEmail, '');
  const { user } = await createCustomer({ isEmailVerified: true });
  other.owner = user._id; await other.save();
  assert.equal((await notificationSettings(other._id)).adminEmail, user.email);
});

test('saved email switches stop queued sends without affecting in-app alerts', async t => {
  await fixture();
  const send = t.mock.method(email, 'sendTransactionalEmail', async () => ({}));
  await Settings.create({ orderAdminEmailEnabled: false, orderCustomerEmailEnabled: false });
  await service.runOrderNotificationTick();
  assert.equal(send.mock.callCount(), 0);
  assert.equal(await Delivery.countDocuments({ reason: 'DISABLED_IN_SETTINGS' }), 2);
  assert.equal(await Delivery.countDocuments({ status: 'SENT' }), 1);
});

test('temporary errors retry the identical message/key and redact raw provider errors', async t => {
  const { order } = await fixture();
  const job = await onlyEmail(order);
  const attempts = [];
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(line));
  t.mock.method(email, 'sendTransactionalEmail', async payload => {
    attempts.push(payload);
    if (attempts.length === 1) throw new Error('SECRET api-key and private@test.local');
    return { messageId: 'ok' };
  });
  await service.processNextDelivery();
  assert.equal((await Delivery.findById(job._id)).status, 'QUEUED');
  await dueAgain(job._id);
  await service.processNextDelivery();
  assert.equal((await Delivery.findById(job._id)).status, 'ACCEPTED');
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(logs.join('').includes('SECRET'), false);
  assert.equal(logs.join('').includes('private@test.local'), false);
});

test('expired provider uncertainty is not blindly retried after a long server sleep', async t => {
  const { order } = await fixture();
  const job = await onlyEmail(order);
  await Delivery.updateOne({ _id: job._id }, { $set: { status: 'PROCESSING', leaseUntil: new Date(0), firstAttemptAt: new Date(Date.now() - 31 * 60000), ambiguous: true } });
  const send = t.mock.method(email, 'sendTransactionalEmail', async () => ({}));
  await service.processNextDelivery();
  assert.equal((await Delivery.findById(job._id)).status, 'UNCERTAIN');
  assert.equal(send.mock.callCount(), 0);
});

test('authentication rejection blocks safely; duplicate responses stay uncertain', async t => {
  const { order } = await fixture();
  const job = await onlyEmail(order);
  let rejection = { statusCode: 401 };
  t.mock.method(email, 'sendTransactionalEmail', async () => { throw Object.assign(new Error('private provider detail'), rejection); });
  await service.processNextDelivery();
  const blocked = await Delivery.findById(job._id);
  assert.equal(blocked.status, 'BLOCKED'); assert.equal(blocked.ambiguous, false);
  await Delivery.updateOne({ _id: job._id }, { $set: { status: 'QUEUED', availableAt: new Date(0) } });
  rejection = { statusCode: 400, providerCode: 'duplicate_parameter' };
  await service.processNextDelivery();
  assert.equal((await Delivery.findById(job._id)).status, 'UNCERTAIN');
});

test('rate-limit retries are bounded and can be retried manually after quota is restored', async t => {
  const { order } = await fixture();
  const job = await onlyEmail(order);
  t.mock.method(email, 'sendTransactionalEmail', async () => { throw Object.assign(new Error('quota'), { statusCode: 429 }); });
  for (let index = 0; index < 5; index += 1) { await dueAgain(job._id); await service.processNextDelivery(); }
  const failed = await Delivery.findById(job._id);
  assert.equal(failed.status, 'FAILED'); assert.equal(failed.attempts, 5); assert.equal(failed.ambiguous, false);
});

test('cancelling before the worker sends suppresses stale confirmation emails', async t => {
  const { order } = await fixture();
  await service.queueOrderNotifications(order._id);
  await Order.updateOne({ _id: order._id }, { $set: { orderStatus: 'Cancelled' } });
  const send = t.mock.method(email, 'sendTransactionalEmail', async () => ({}));
  await service.runOrderNotificationTick();
  assert.equal(send.mock.callCount(), 0);
  assert.equal(await Delivery.countDocuments({ reason: 'ORDER_NO_LONGER_ELIGIBLE' }), 3);
});

test('email content escapes product HTML, uses stored totals and never calls pending COD paid', async () => {
  const { order } = await fixture({ orderItems: [{ name: '<img onerror="bad">', quantity: 2, price: 299 }], codVerification: { required: true, status: 'PENDING' } });
  const result = buildOrderEmail(order, 'CUSTOMER');
  assert.ok(result.htmlContent.includes('&lt;img'));
  assert.equal(result.htmlContent.includes('<img'), false);
  assert.ok(result.textContent.includes('INR 599.00'));
  assert.ok(result.textContent.includes('complete COD verification'));
  assert.ok(result.textContent.includes('https://shop.test/order-detail?id='));
  assert.equal(result.textContent.includes('Online payment confirmed'), false);
});

test('admin diagnostics and retry are protected; private recipient stays out of public settings', async () => {
  const { token: admin } = await createAdmin();
  const { token: customer } = await createCustomer();
  await Settings.create({ orderNotificationEmail: 'private@test.local' });
  const { order } = await fixture();
  const job = await onlyEmail(order);
  await Delivery.updateOne({ _id: job._id }, { $set: { status: 'BLOCKED', reason: 'EMAIL_NOT_CONFIGURED' } });
  assert.equal((await request('/api/admin/settings/order-notifications')).status, 401);
  assert.equal((await request('/api/admin/settings/order-notifications', { token: customer })).status, 403);
  const status = await request('/api/admin/settings/order-notifications', { token: admin });
  assert.equal(status.status, 200);
  assert.equal(status.data.adminEmail, 'private@test.local');
  assert.equal(status.data.items.length, 3);
  assert.equal(status.data.items.some(item => item.email || item.idempotencyKey), false);
  const publicSettings = await request('/api/settings');
  assert.equal(publicSettings.data.orderNotificationEmail, undefined);
  assert.equal((await request(`/api/admin/settings/order-notifications/${job._id}/retry`, { method: 'POST', token: admin, body: {} })).status, 200);
  assert.equal((await Delivery.findById(job._id)).status, 'QUEUED');
});

test('tenant delivery diagnostics/retry cannot access another store', async () => {
  const storeA = await Store.create({ name: 'A', slug: 'a' });
  const storeB = await Store.create({ name: 'B', slug: 'b' });
  const { order } = await fixture({ storeId: storeB._id });
  const job = await onlyEmail(order);
  await Delivery.updateOne({ _id: job._id }, { $set: { status: 'BLOCKED' } });
  let body; let error;
  const req = { store: storeA, params: { id: String(job._id) } };
  await controller.status(req, { json: value => { body = value; } }, e => { error = e; });
  assert.equal(error, undefined); assert.equal(body.items.length, 0); assert.equal(body.adminEmail, '');
  await controller.retry(req, { json: () => {} }, e => { error = e; });
  assert.equal(error.statusCode, 404);
});

test('email transport uses backend credentials, finite timeout and provider idempotency', async t => {
  let captured;
  t.mock.method(global, 'fetch', async (url, options) => { captured = { url, options }; return { ok: true, json: async () => ({ messageId: 'abc' }) }; });
  await email.sendTransactionalEmail({ to: 'customer@test.local', subject: 'Order', htmlContent: '<p>Order</p>', textContent: 'Order', idempotencyKey: 'request-uuid' });
  assert.equal(captured.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(captured.options.headers['api-key'], 'fixture-not-a-real-key');
  assert.ok(captured.options.signal);
  const body = JSON.parse(captured.options.body);
  assert.equal(body.headers.idempotencyKey, 'request-uuid');
  assert.equal(body.textContent, 'Order');
  assert.equal(body.sender.email, 'sender@test.local');
});

test('an ambiguous attempt stays unsafe to resend even if a later request gets an auth error', async t => {
  const { order } = await fixture();
  const job = await onlyEmail(order);
  let attempt = 0;
  t.mock.method(email, 'sendTransactionalEmail', async () => {
    attempt += 1;
    throw Object.assign(new Error('redacted'), attempt === 1 ? {} : { statusCode: 403 });
  });
  await service.processNextDelivery();
  await dueAgain(job._id);
  await service.processNextDelivery();
  const uncertain = await Delivery.findById(job._id);
  assert.equal(uncertain.status, 'UNCERTAIN');
  assert.equal(uncertain.ambiguous, true);
});

test('an expired in-flight lease is recovered with the same payload and idempotency key inside the safe window', async t => {
  const { order } = await fixture();
  const job = await onlyEmail(order);
  const content = { to: 'owner@test.local', ...buildOrderEmail(order, 'ADMIN') };
  await Delivery.updateOne({ _id: job._id }, { $set: { status: 'PROCESSING', leaseUntil: new Date(0), firstAttemptAt: new Date(), email: content, ambiguous: true } });
  let payload;
  t.mock.method(email, 'sendTransactionalEmail', async input => { payload = input; return { messageId: 'accepted' }; });
  await service.processNextDelivery();
  assert.deepEqual(payload, { ...content, idempotencyKey: job.idempotencyKey });
  assert.equal((await Delivery.findById(job._id)).status, 'ACCEPTED');
});

test('recipient email is validated and settings require actual booleans', () => {
  const { normalizeSettingsUpdates } = require('../services/storeSettingsValidation');
  const current = { storeName: 'Nishaya Jewellery' };
  assert.throws(() => normalizeSettingsUpdates({ orderNotificationEmail: 'invalid-address' }, current));
  assert.throws(() => normalizeSettingsUpdates({ orderAdminEmailEnabled: 'false' }, current));
  const result = normalizeSettingsUpdates({ orderNotificationEmail: ' orders@example.com ', orderAdminEmailEnabled: false }, current);
  assert.equal(result.orderNotificationEmail, 'orders@example.com');
  assert.equal(result.orderAdminEmailEnabled, false);
});

test('worker startup recovers persisted jobs and shutdown waits for the active batch', async t => {
  await fixture();
  const send = t.mock.method(email, 'sendTransactionalEmail', async () => ({ messageId: 'worker-test' }));
  const stop = service.startOrderNotificationWorker();
  try { await service.runOrderNotificationTick(); } finally { await stop(); }
  assert.equal(send.mock.callCount(), 2);
  assert.equal(await Delivery.countDocuments({ status: 'PROCESSING' }), 0);
  assert.equal(await Delivery.countDocuments({ status: 'ACCEPTED' }), 2);
});

test('retry refuses already accepted or uncertain delivery and wrong-store administrators', async () => {
  const { token: admin } = await createAdmin();
  const { order } = await fixture();
  const job = await onlyEmail(order);
  for (const status of ['ACCEPTED', 'UNCERTAIN']) {
    await Delivery.updateOne({ _id: job._id }, { $set: { status } });
    assert.equal((await request(`/api/admin/settings/order-notifications/${job._id}/retry`, { method: 'POST', token: admin, body: {} })).status, 404);
  }
  await Store.create({ name: 'Other private store', slug: 'private-store', status: 'PUBLISHED' });
  const status = await request('/api/admin/settings/order-notifications?store=private-store', { token: admin });
  assert.equal(status.status, 403);
});
