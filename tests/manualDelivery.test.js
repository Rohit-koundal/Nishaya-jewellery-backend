const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment, getBaseUrl } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Order = require('../models/Order');
const Shipment = require('../models/Shipment');
const Product = require('../models/Product');
const { trackingUrl, deliveryDate } = require('../services/manualDeliveryService');

// Manual fulfilment is core order management, not licensed courier automation.
test.mock.method(require('../services/controlPlaneClient'), 'licenseStatus', async () => ({ managed: true, status: 'ACTIVE', features: [], limits: {} }));
test.before(startTestEnvironment);
test.after(stopTestEnvironment);
let admin, customer;
test.beforeEach(async t => {
  await resetDatabase();
  await setSettings({ shippingProvider: 'manual' });
  admin = await createAdmin(); customer = await createCustomer();
  const localFetch = global.fetch;
  t.mock.method(global, 'fetch', (url, options) => {
    assert.ok(String(url).startsWith(`${getBaseUrl()}/`), 'Manual delivery must not call an external service');
    return localFetch(url, options);
  });
});
async function orderFixture(overrides = {}) {
  return Order.create({ user: customer.user._id, orderStatus: 'Confirmed', paymentMethod: 'COD', paymentStatus: 'Pending', codConfirmationStatus: 'CONFIRMED', shippingAddress: validAddress(), finalAmount: 500, ...overrides });
}
async function save(order, body = {}, token = admin.token) {
  const fresh = await Order.findById(order._id);
  return request(`/api/admin/orders/${order._id}/shipment`, { method: 'PUT', token, body: { revision: fresh.revision || 0, deliveryMode: 'SELF', ...body } });
}
async function status(order, orderStatus, extra = {}) {
  const fresh = await Order.findById(order._id);
  return request(`/api/admin/orders/${order._id}/status`, { method: 'PUT', token: admin.token, body: { orderStatus, revision: fresh.revision || 0, ...extra } });
}
function ok(result) { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

test('self delivery completes without an AWB, records recipient, and keeps COD collection separate', async () => {
  const order = await orderFixture();
  const shipment = ok(await save(order, { deliveryContact: { name: 'Store desk', phone: '+919000000001' }, expectedDeliveryAt: tomorrow() }));
  assert.equal(shipment.deliveryMode, 'SELF'); assert.ok(!shipment.awb);
  for (const next of ['Packed', 'Shipped', 'Out for Delivery']) ok(await status(order, next));
  assert.equal((await status(order, 'Delivered')).status, 400);
  ok(await status(order, 'Delivered', { receivedBy: 'Test recipient', deliveryReference: 'HANDOVER-1', deliveryOtpVerified: true }));
  const delivered = await Order.findById(order._id);
  assert.equal(delivered.paymentStatus, 'Pending');
  assert.equal(delivered.deliveryProof.receivedBy, 'Test recipient');
  assert.equal(delivered.deliveryProof.deliveryOtpVerified, false);
  assert.equal((await Shipment.findById(delivered.shipment)).status, 'DELIVERED');
  const tracking = ok(await request(`/api/orders/${order._id}/tracking?refresh=1`, { token: customer.token }));
  assert.equal(tracking.shipment.deliveryContact.phone, '9000000001');
  assert.equal(tracking.order.deliveryProof.receivedBy, 'Test recipient');
  assert.equal(tracking.order.deliveryProof.deliveryOtpVerified, undefined);
  ok(await request(`/api/admin/orders/${order._id}/payment-status`, { method: 'PUT', token: admin.token, body: { paymentStatus: 'Paid', revision: delivered.revision, note: 'Cash received from customer', reference: 'CASH-1' } }));
  assert.equal((await Order.findById(order._id)).paymentStatus, 'Paid');
});

test('manual courier validates real tracking, saves HTTPS link and rejects unsafe or malformed details', async () => {
  const order = await orderFixture();
  const body = { deliveryMode: 'COURIER', courierName: 'Test Courier', trackingNumber: 'AWB-123', trackingUrl: 'https://courier.example/track/AWB-123' };
  assert.equal((await save(order, { ...body, trackingNumber: '' })).status, 400);
  assert.equal((await save(order, { ...body, awb: { bad: true } })).status, 400);
  assert.equal((await save(order, { ...body, deliveryContact: { phone: '123' } })).status, 400);
  assert.equal((await save(order, { ...body, trackingUrl: 'javascript:alert(1)' })).status, 400);
  const result = ok(await save(order, body));
  assert.equal(result.awb, 'AWB-123'); assert.equal(result.trackingUrl, body.trackingUrl);
  for (const next of ['Packed', 'Shipped']) ok(await status(order, next));
  assert.equal((await save(order, { deliveryMode: 'SELF' })).status, 400);
  assert.equal((await save(order, { ...body, trackingNumber: 'NEW-123' })).status, 400);
  ok(await save(order, { ...body, trackingNumber: 'NEW-123', note: 'Corrected the courier receipt number.' }));
});

test('old revisions and double submissions do not overwrite details or duplicate delivery events', async () => {
  const order = await orderFixture();
  ok(await save(order));
  assert.equal((await save(order, { revision: 0, note: 'Stale session' })).status, 409);
  const before = await Order.findById(order._id);
  const results = await Promise.all([save(order, { revision: before.revision, event: 'NOTE', note: 'Parcel is being prepared.' }), save(order, { revision: before.revision, event: 'NOTE', note: 'Parcel is being prepared.' })]);
  assert.equal(results.filter(r => r.status === 200).length, 1, JSON.stringify(results));
  assert.equal(results.filter(r => r.status === 409).length, 1, JSON.stringify(results));
  const shipment = await Shipment.findOne({ order: order._id });
  assert.equal(shipment.events.filter(e => e.status === 'DELIVERY_UPDATE').length, 1);
});

test('failed delivery blocks completion until redelivery is scheduled', async () => {
  const order = await orderFixture(); ok(await save(order));
  for (const next of ['Packed', 'Shipped', 'Out for Delivery']) ok(await status(order, next));
  ok(await save(order, { event: 'ATTEMPT_FAILED', note: 'Customer unavailable at the address.' }));
  assert.equal((await status(order, 'Delivered', { receivedBy: 'Recipient' })).status, 409);
  assert.equal((await save(order, { event: 'RESCHEDULED', note: 'Customer requested another attempt.' })).status, 400);
  ok(await save(order, { event: 'RESCHEDULED', expectedDeliveryAt: tomorrow(), note: 'Customer requested delivery tomorrow.' }));
  ok(await status(order, 'Delivered', { receivedBy: 'Recipient' }));
});

test('return to origin requires receipt and inspection, without premature restock or refund', async () => {
  const product = await createProduct({ stock: 4 });
  const order = await orderFixture({ orderItems: [{ product: product._id, quantity: 1, price: 500 }] });
  ok(await save(order)); for (const next of ['Packed', 'Shipped']) ok(await status(order, next));
  assert.equal((await save(order, { event: 'RTO_RECEIVED', note: 'Received parcel' })).status, 400);
  ok(await save(order, { event: 'RTO_STARTED', note: 'Customer refused the parcel.' }));
  assert.equal((await status(order, 'Out for Delivery')).status, 409);
  ok(await save(order, { event: 'RTO_RECEIVED', note: 'Sealed parcel received at the store.' }));
  const fresh = await Order.findById(order._id);
  assert.equal(fresh.rto.status, 'QC_PENDING');
  assert.equal(fresh.paymentStatus, 'Pending');
  assert.equal((await Product.findById(product._id)).stock, 4);
  assert.equal((await Shipment.findOne({ order: order._id })).status, 'RETURNED');
  assert.equal((await save(order, { event: 'NOTE', note: 'Cannot edit a closed parcel' })).status, 400);
});

test('cancellation closes pre-dispatch manual shipment and history without dispatching it', async () => {
  const order = await orderFixture(); ok(await save(order));
  ok(await status(order, 'Cancelled', { note: 'Customer cancelled before dispatch' }));
  assert.equal((await Shipment.findOne({ order: order._id })).status, 'CANCELLED');
  assert.equal((await save(order)).status, 400);
});

test('concurrent RTO inspections cannot receive the same parcel into two inventory buckets', async () => {
  const product = await createProduct({ stock: 4 });
  const order = await orderFixture({ orderItems: [{ product: product._id, quantity: 1, price: 500 }] });
  ok(await save(order)); for (const next of ['Packed', 'Shipped']) ok(await status(order, next));
  ok(await save(order, { event: 'RTO_STARTED', note: 'Return requested after failed delivery.' }));
  ok(await save(order, { event: 'RTO_RECEIVED', note: 'Parcel received at the store.' }));
  const fresh = await Order.findById(order._id);
  const results = await Promise.all(['RESTOCK', 'QUARANTINE'].map(disposition => request(`/api/admin/orders/${order._id}/rto/inspect`, { method: 'POST', token: admin.token, body: { disposition, receivedQuantity: 1, revision: fresh.revision, notes: 'Inspected the returned parcel.' } })));
  assert.equal(results.filter(r => r.status === 200).length, 1, JSON.stringify(results));
  assert.equal(results.filter(r => r.status === 409).length, 1, JSON.stringify(results));
  const inspected = await Order.findById(order._id);
  assert.equal(inspected.rto.inventoryRecorded, true);
  assert.equal(inspected.rto.refundStatus, 'NOT_REQUIRED');
  const again = await request(`/api/admin/orders/${order._id}/rto/inspect`, { method: 'POST', token: admin.token, body: { disposition: 'RESTOCK', receivedQuantity: 1, revision: inspected.revision, notes: 'Cannot inspect twice.' } });
  assert.equal(again.status, 409);
  const stock = await Product.findById(product._id);
  assert.equal(stock.stock, inspected.rto.disposition === 'RESTOCK' ? 5 : 4);
});

test('manual edits cannot replace integrated bookings or bypass COD verification and payment', async () => {
  for (const overrides of [{ orderStatus: 'Pending' }, { paymentMethod: 'UPI', paymentStatus: 'Pending' }, { codConfirmationStatus: 'PENDING' }, { codVerification: { required: true, status: 'PENDING' } }]) {
    const order = await orderFixture(overrides);
    const result = await save(order); assert.ok([400, 409].includes(result.status), JSON.stringify(result));
    assert.equal(await Shipment.countDocuments({ order: order._id }), 0);
  }
  const order = await orderFixture();
  await Shipment.create({ order: order._id, provider: 'delhivery', awb: 'INTEGRATED-1' });
  assert.equal((await save(order)).status, 400);
  assert.equal((await Shipment.findOne({ order: order._id })).awb, 'INTEGRATED-1');
});

test('tracking is authenticated, scoped to the customer and excludes internal shipment fields', async () => {
  const order = await orderFixture(); const shipment = ok(await save(order));
  await Shipment.updateOne({ _id: shipment._id }, { $set: { operation: 'private-operation', lastError: 'private-provider-error', pickupAddress: { secret: true }, destination: { secret: true }, providerCharge: 20 } });
  const stranger = await createCustomer();
  assert.equal((await request(`/api/orders/${order._id}/tracking`)).status, 401);
  assert.equal((await request(`/api/orders/${order._id}/tracking`, { token: stranger.token })).status, 403);
  assert.equal((await save(order, {}, customer.token)).status, 403);
  for (const path of [`/api/orders/${order._id}/tracking?refresh=1`, `/api/orders/${order._id}`]) {
    const data = ok(await request(path, { token: customer.token }));
    for (const field of ['operation', 'lastError', 'pickupAddress', 'destination', 'providerCharge']) assert.equal(data.shipment[field], undefined, field);
  }
});

test('manual checkout still uses configured delivery charges without a courier account', async () => {
  await setSettings({ shippingProvider: 'manual', shippingPricingMode: 'fixed', shippingFreeAboveEnabled: false, deliveryCharge: 75 });
  const product = await createProduct({ price: 500 });
  const placed = await request('/api/orders/cod', { method: 'POST', token: customer.token, body: { orderItems: [{ product: String(product._id), quantity: 1 }], shippingAddress: validAddress(), paymentMethod: 'COD' } });
  assert.equal(placed.status, 201, JSON.stringify(placed.data)); assert.equal(placed.data.deliveryCharge, 75);
});

test('duplicate AWBs roll back the order revision and leave the second shipment untouched', async () => {
  await Shipment.init();
  const first = await orderFixture(); const second = await orderFixture();
  const details = { deliveryMode: 'COURIER', courierName: 'Same courier', trackingNumber: 'UNIQUE-123' };
  ok(await save(first, details));
  const result = await save(second, details);
  assert.equal(result.status, 400, JSON.stringify(result.data));
  const fresh = await Order.findById(second._id);
  assert.equal(fresh.revision, 0); assert.ok(!fresh.shipment);
  assert.equal(await Shipment.countDocuments({ order: second._id }), 0);
});

test('shipment persistence failure cannot leave the order falsely delivered', async t => {
  const order = await orderFixture(); ok(await save(order));
  for (const next of ['Packed', 'Shipped', 'Out for Delivery']) ok(await status(order, next));
  const before = await Order.findById(order._id);
  const originalSave = Shipment.prototype.save;
  t.mock.method(Shipment.prototype, 'save', async function (...args) {
    if (this.status === 'DELIVERED') throw new Error('Simulated shipment persistence failure');
    return originalSave.apply(this, args);
  });
  assert.equal((await status(order, 'Delivered', { receivedBy: 'Recipient' })).status, 500);
  const fresh = await Order.findById(order._id);
  assert.equal(fresh.orderStatus, 'Out for Delivery'); assert.equal(fresh.revision, before.revision);
  assert.ok(!fresh.deliveredAt);
  assert.equal((await Shipment.findById(fresh.shipment)).status, 'OUT_FOR_DELIVERY');
});

test('an unchanged details retry creates neither a duplicate event nor a new revision', async () => {
  const order = await orderFixture(); ok(await save(order));
  const before = await Order.findById(order._id);
  const shipment = await Shipment.findById(before.shipment);
  ok(await save(order));
  assert.equal((await Order.findById(order._id)).revision, before.revision);
  assert.equal((await Shipment.findById(before.shipment)).events.length, shipment.events.length);
});

test('tracking URL and ETA validation rejects local destinations, credentials and invalid dates', () => {
  for (const url of ['http://courier.example', 'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://user:pass@courier.example/x']) assert.throws(() => trackingUrl(url));
  for (const date of ['2026-02-30', '2000-01-01', 'not-a-date']) assert.throws(() => deliveryDate(date));
  assert.equal(trackingUrl(''), ''); assert.ok(deliveryDate(tomorrow()) instanceof Date);
});
