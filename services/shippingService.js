const Order = require('../models/Order');
const Shipment = require('../models/Shipment');
const { ApiError, notFound } = require('../utils/apiError');
const { notifyLater } = require('./notificationService');

function toShipmentStatus(orderStatus) {
  if (orderStatus === 'Packed') return 'READY_TO_SHIP';
  if (orderStatus === 'Shipped') return 'SHIPPED';
  if (orderStatus === 'Out for Delivery') return 'OUT_FOR_DELIVERY';
  if (orderStatus === 'Delivered') return 'DELIVERED';
  return null;
}

async function upsertShipmentForOrder(order, { courierName, trackingNumber, trackingUrl, awb, status, note } = {}) {
  if (!order) throw notFound('Order not found');
  require('./codVerificationService').assertCodDispatchable(order);
  if (order.paymentMethod === 'COD' && order.codConfirmationStatus === 'PENDING') throw new ApiError('VALIDATION_ERROR', 'Confirm this cash-on-delivery order with the customer before arranging shipment.');

  const nextStatus = status || toShipmentStatus(order.orderStatus) || 'READY_TO_SHIP';
  const payload = {
    courierName: courierName || undefined,
    trackingNumber: trackingNumber || undefined,
    trackingUrl: trackingUrl || undefined,
    awb: awb || trackingNumber || undefined,
    status: nextStatus,
  };

  let shipment = order.shipment
    ? await Shipment.findById(order.shipment._id || order.shipment)
    : await Shipment.findOne({ order: order._id });

  if (shipment?.provider && shipment.provider !== 'manual') throw new ApiError('SHIPPING_VALIDATION', `This shipment is managed by ${shipment.courierName || 'an integrated courier'}. Use courier booking, pickup and tracking actions.`);
  if (!Shipment.SHIPMENT_STATUSES.includes(nextStatus)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid shipment status.');
  if (trackingUrl) {
    let url;
    try { url = new URL(trackingUrl); } catch { throw new ApiError('VALIDATION_ERROR', 'Enter a valid tracking URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new ApiError('VALIDATION_ERROR', 'Tracking links must use a secure HTTPS URL.');
  }

  if (!shipment) {
    shipment = await Shipment.create({
      order: order._id,
      storeId: order.storeId || undefined,
      provider: 'manual',
      events: [{ status: nextStatus, note: note || 'Shipment created', date: new Date() }],
      ...payload,
    });
    order.shipment = shipment._id;
    await order.save();
  } else {
    Object.assign(shipment, Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined)));
    if (!shipment.storeId && order.storeId) shipment.storeId = order.storeId;
    shipment.events.push({ status: nextStatus, note: note || `Status set to ${nextStatus}`, date: new Date() });
    await shipment.save();
  }

  if (['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(nextStatus)) {
    notifyLater({
      userId: order.user,
      storeId: order.storeId,
      event: nextStatus === 'OUT_FOR_DELIVERY' ? 'ORDER_OUT_FOR_DELIVERY' : 'ORDER_SHIPPED',
      title: nextStatus === 'OUT_FOR_DELIVERY' ? 'Out for delivery' : 'Your order is on the way',
      message: shipment.trackingNumber
        ? `Tracking ${shipment.trackingNumber}${shipment.courierName ? ` via ${shipment.courierName}` : ''}`
        : nextStatus === 'OUT_FOR_DELIVERY' ? 'Your order is out for delivery.' : 'Your order is on the way.',
      metadata: { orderId: String(order._id), shipmentId: String(shipment._id) },
    });
  }

  return shipment;
}

async function getShipmentForOrder(orderId) {
  const order = await Order.findById(orderId).select('shipment');
  if (!order) throw new ApiError('NOT_FOUND', 'Order not found');
  if (order.shipment) return Shipment.findById(order.shipment);
  return Shipment.findOne({ order: orderId });
}

module.exports = {
  getShipmentForOrder,
  toShipmentStatus,
  upsertShipmentForOrder,
};
