const { isIP } = require('node:net');
const Order = require('../models/Order');
const Shipment = require('../models/Shipment');
const { ApiError } = require('../utils/apiError');
const { optionalString } = require('../utils/validators');
const { runInTransaction } = require('../utils/transaction');
const { normalizeIndianMobile } = require('../utils/phoneUtils');
const { assertCodDispatchable } = require('./codVerificationService');
const { withOrderLock } = require('./deliveryService');
const { toShipmentStatus } = require('./shippingService');
const { notifyLater } = require('./notificationService');

const fail = message => new ApiError('SHIPPING_VALIDATION', message);
const changed = () => new ApiError('ORDER_CHANGED', 'This order changed in another session. Reload it before continuing.', { statusCode: 409 });
const inTransit = ['Shipped', 'Out for Delivery'];
const EVENTS = ['DETAILS', 'NOTE', 'ATTEMPT_FAILED', 'RESCHEDULED', 'RTO_STARTED', 'RTO_RECEIVED'];

function trackingUrl(value) {
  const text = optionalString(value, 'trackingUrl', { max: 500 });
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw fail('Enter a valid courier tracking URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.') || /(^|\.)(localhost|local|internal)$/i.test(url.hostname)) {
    throw fail('Tracking links must use a public HTTPS courier website without embedded credentials.');
  }
  return url.href;
}

function deliveryDate(value, previous) {
  if (!value) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail('Choose a valid expected delivery date.');
  const at = new Date(`${value}T12:00:00+05:30`);
  if (!Number.isFinite(at.getTime()) || at.toISOString().slice(0, 10) !== value) throw fail('Choose a valid expected delivery date.');
  if (previous && new Date(previous).toISOString().slice(0, 10) === value) return at;
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  if (value < today || at.getTime() > Date.now() + 180 * 86400000) throw fail('Expected delivery must be today or within the next 180 days.');
  return at;
}

// Store-managed delivery never calls a carrier, invents an AWB, collects COD,
// restocks returned goods, or grants a refund. Those keep their own workflows.
async function saveManualDelivery(order, body = {}) {
  return withOrderLock(order._id, async () => {
    const result = await runInTransaction(async session => {
      const current = await Order.findById(order._id).session(session);
      if (!current) throw changed();
      const revision = Number(current.revision || 0);
      if (body.revision !== undefined && (!Number.isInteger(body.revision) || body.revision !== revision)) throw changed();
      if (!['Confirmed', 'Packed', ...inTransit].includes(current.orderStatus)) throw fail('Manual delivery can only be edited for a confirmed, active order.');
      assertCodDispatchable(current);
      if (current.paymentMethod !== 'COD' && current.paymentStatus !== 'Paid') throw fail('Online payment must be confirmed before arranging delivery.');
      if (['Failed', 'Refunded'].includes(current.paymentStatus) || (current.paymentMethod === 'COD' && current.codConfirmationStatus === 'PENDING')) throw fail('Confirm this order and its payment eligibility before arranging delivery.');

      let shipment = await Shipment.findOne({ order: current._id }).session(session);
      if (shipment?.provider && shipment.provider !== 'manual') throw fail('This order has an integrated courier shipment. Use its existing courier controls.');
      if (['DELIVERED', 'CANCELLED', 'RETURNED'].includes(shipment?.status)) throw fail('This shipment is closed and cannot be edited.');
      const event = body.event || 'DETAILS';
      if (!EVENTS.includes(event)) throw fail('Choose a valid manual delivery update.');
      const note = optionalString(body.note, 'note', { max: 300 });
      if (event !== 'DETAILS' && note.length < 3) throw fail('Enter a customer-visible delivery update (at least 3 characters).');
      if (event !== 'DETAILS' && !shipment) throw fail('Save the delivery details first.');
      if (body.status !== undefined && body.status !== toShipmentStatus(current.orderStatus)) throw fail('Use the order workflow to change delivery status.');
      const rtoStatus = current.rto?.status || 'NONE';
      if (rtoStatus !== 'NONE' && event !== 'RTO_RECEIVED') throw fail('This parcel is returning to the store. Complete the return-to-origin workflow.');
      const now = new Date();
      const isNew = !shipment;
      if (!shipment) shipment = new Shipment({ order: current._id, storeId: current.storeId || undefined, provider: 'manual', status: toShipmentStatus(current.orderStatus) || 'WAITING' });
      const before = shipment.toObject();
      let eventStatus = 'DETAILS_UPDATED';
      const orderSet = { shipment: shipment._id };
      let orderEvent;

      if (event === 'DETAILS') {
        const mode = body.deliveryMode ?? shipment.deliveryMode ?? 'COURIER';
        if (!['SELF', 'COURIER'].includes(mode)) throw fail('Choose self delivery or manual courier.');
        if (inTransit.includes(current.orderStatus) && mode !== (shipment.deliveryMode || 'COURIER')) throw fail('Delivery mode cannot change after dispatch.');
        const courierName = optionalString(body.courierName ?? shipment.courierName, 'courierName', { max: 80 });
        const tracking = optionalString(body.trackingNumber ?? body.awb ?? shipment.trackingNumber ?? shipment.awb, 'trackingNumber', { max: 80 });
        if ([body.awb, body.trackingNumber].some(value => value !== undefined && typeof value !== 'string')) throw fail('AWB and tracking number must be text.');
        if (body.awb && body.trackingNumber && body.awb.trim() !== body.trackingNumber.trim()) throw fail('AWB and tracking number must match.');
        if (mode === 'COURIER' && (!courierName || !tracking)) throw fail('Enter the courier name and its real AWB / tracking number.');
        if (tracking && !/^[a-zA-Z0-9][a-zA-Z0-9 /_-]{0,79}$/.test(tracking)) throw fail('Tracking number contains unsupported characters.');
        if (inTransit.includes(current.orderStatus) && tracking !== (shipment.trackingNumber || shipment.awb || '') && note.length < 3) throw fail('Explain the tracking-number correction in the customer-visible note.');
        const phone = optionalString(body.deliveryContact?.phone ?? shipment.deliveryContact?.phone, 'delivery phone', { max: 20 });
        const normalizedPhone = phone ? normalizeIndianMobile(phone) : '';
        if (phone && !/^[6-9]\d{9}$/.test(normalizedPhone)) throw fail('Enter a valid 10-digit delivery contact mobile number.');
        shipment.deliveryMode = mode;
        shipment.courierName = mode === 'SELF' ? 'Store delivery' : courierName;
        shipment.trackingNumber = mode === 'SELF' ? '' : tracking;
        shipment.awb = mode === 'SELF' ? undefined : tracking;
        shipment.trackingUrl = mode === 'SELF' ? '' : trackingUrl(body.trackingUrl ?? shipment.trackingUrl);
        shipment.deliveryContact = {
          name: optionalString(body.deliveryContact?.name ?? shipment.deliveryContact?.name, 'delivery contact name', { max: 100 }),
          phone: normalizedPhone,
        };
        if (body.expectedDeliveryAt !== undefined) shipment.expectedDeliveryAt = deliveryDate(body.expectedDeliveryAt, shipment.expectedDeliveryAt);
      } else if (event === 'NOTE') {
        eventStatus = 'DELIVERY_UPDATE';
      } else if (event === 'ATTEMPT_FAILED') {
        if (!inTransit.includes(current.orderStatus)) throw fail('A delivery attempt can only be recorded after dispatch.');
        shipment.status = 'EXCEPTION'; eventStatus = 'ATTEMPT_FAILED';
      } else if (event === 'RESCHEDULED') {
        if (!inTransit.includes(current.orderStatus)) throw fail('Redelivery can only be scheduled after dispatch.');
        shipment.expectedDeliveryAt = deliveryDate(body.expectedDeliveryAt);
        if (!shipment.expectedDeliveryAt) throw fail('Choose the new expected delivery date.');
        shipment.status = toShipmentStatus(current.orderStatus); eventStatus = 'RESCHEDULED';
      } else if (event === 'RTO_STARTED') {
        if (!inTransit.includes(current.orderStatus) || rtoStatus !== 'NONE') throw fail('Only a dispatched parcel can be returned to the store.');
        shipment.status = eventStatus = 'RTO_IN_TRANSIT';
        Object.assign(orderSet, { 'rto.status': 'IN_TRANSIT', 'rto.reason': note, 'rto.triggeredAt': now });
        orderEvent = { status: 'RTO in transit', note, date: now };
      } else if (event === 'RTO_RECEIVED') {
        if (rtoStatus !== 'IN_TRANSIT' || shipment.status !== 'RTO_IN_TRANSIT') throw fail('Record return-to-origin dispatch before receiving this parcel.');
        shipment.status = eventStatus = 'RETURNED';
        Object.assign(orderSet, { 'rto.status': 'QC_PENDING', 'rto.receivedAt': now, 'rto.disposition': 'PENDING' });
        orderEvent = { status: 'RTO received', note: `${note} Inventory inspection is pending.`, date: now };
      }

      const fieldSnapshot = row => JSON.stringify([row.deliveryMode, row.courierName, row.trackingNumber, row.trackingUrl, row.deliveryContact?.name || '', row.deliveryContact?.phone || '', row.expectedDeliveryAt ? new Date(row.expectedDeliveryAt).toISOString() : '']);
      if (!isNew && event === 'DETAILS' && !note && fieldSnapshot(before) === fieldSnapshot(shipment)) return { shipment, changed: false };
      shipment.manualUpdatedAt = now;
      shipment.events.push({ status: eventStatus, note: note || (shipment.deliveryMode === 'SELF' ? 'Delivery will be handled directly by the store.' : `Shipment details saved for ${shipment.courierName}.`), date: now });
      await shipment.validate();
      const versionFilter = revision === 0 ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] } : { revision };
      const updated = await Order.findOneAndUpdate({ _id: current._id, orderStatus: current.orderStatus, ...versionFilter }, {
        $set: orderSet, $inc: { revision: 1 }, ...(orderEvent ? { $push: { statusTimeline: orderEvent } } : {}),
      }, { new: true, session });
      if (!updated) throw changed();
      try { await shipment.save({ session }); }
      catch (error) {
        // Atlas rolls both documents back. Compensate a standalone dev database.
        if (!session) await Order.updateOne({ _id: current._id, revision: revision + 1 }, { $set: { revision, shipment: current.shipment || null, rto: current.rto, statusTimeline: current.statusTimeline } });
        if (error.code === 11000) throw fail('This AWB is already assigned to another order in this store. Check the tracking number.');
        throw error;
      }
      return { shipment, changed: true };
    });
    if (result.changed) notifyLater({ userId: order.user, storeId: order.storeId, event: 'ORDER_DELIVERY_UPDATED', title: 'Delivery update', message: result.shipment.events.at(-1).note, metadata: { orderId: String(order._id), shipmentId: String(result.shipment._id) } });
    return result.shipment;
  });
}

module.exports = { saveManualDelivery, trackingUrl, deliveryDate };
