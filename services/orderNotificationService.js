const crypto = require('crypto');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Delivery = require('../models/OrderNotificationDelivery');
const User = require('../models/User');
const emailService = require('./emailService');
const { notify } = require('./notificationService');
const { buildOrderEmail, emailConfiguration, notificationSettings, validEmail } = require('./orderNotificationEmail');
const { log } = require('../utils/logger');

const RETRY_MS = [60000, 120000, 300000, 600000];
// Brevo idempotency keys expire after 30 minutes. Leave a safety margin and
// never blindly resend an ambiguous attempt after that window (e.g. cold start).
const SAFE_RETRY_WINDOW_MS = 25 * 60000;
const eligible = order => order && !['Cancelled', 'Returned', 'Refunded'].includes(order.orderStatus)
  && (order.paymentMethod === 'COD' || order.paymentStatus === 'Paid');
const pendingOrders = {
  orderNotificationVersion: { $in: [1, 2] }, orderNotificationQueuedAt: null,
  orderStatus: { $nin: ['Cancelled', 'Returned', 'Refunded'] },
  $or: [{ paymentMethod: 'COD' }, { paymentStatus: 'Paid' }],
};

async function queueOrderNotifications(orderId) {
  await Delivery.init();
  const order = await Order.findOne({ _id: orderId, ...pendingOrders }).lean();
  if (!eligible(order)) return;
  const event = order.paymentMethod === 'COD' ? 'ORDER_PLACED' : 'ORDER_CONFIRMED';
  // Replaying after a crash or competing webhook is safe. Only mark the order
  // after every job exists. No external side effect occurs in this operation.
  const channels = [['IN_APP', 'ALL'], ['EMAIL', 'ADMIN'], ['EMAIL', 'CUSTOMER']];
  if (order.orderNotificationVersion >= 2) channels.push(['WHATSAPP', 'ADMIN'], ['WHATSAPP', 'CUSTOMER']);
  for (const [channel, audience] of channels) {
    const dedupeKey = `${order._id}:${event}:${channel}:${audience}`;
    try {
      await Delivery.updateOne({ dedupeKey }, { $setOnInsert: {
        dedupeKey, order: order._id, storeId: order.storeId, event, channel, audience,
        status: 'QUEUED', availableAt: new Date(), idempotencyKey: crypto.randomUUID(),
      } }, { upsert: true });
    } catch (error) { if (error.code !== 11000) throw error; }
  }
  await Order.updateOne({ _id: order._id }, { $set: { orderNotificationQueuedAt: new Date() } });
}

async function recoverOrderNotifications() {
  const orders = await Order.find(pendingOrders).sort({ createdAt: 1 }).limit(30).select('_id').lean();
  for (const order of orders) await queueOrderNotifications(order._id);
}

async function processNextDelivery() {
  const now = new Date();
  const leaseToken = crypto.randomUUID();
  const job = await Delivery.findOneAndUpdate({ $or: [
    { status: 'QUEUED', availableAt: { $lte: now } },
    { status: 'PROCESSING', leaseUntil: { $lte: now } },
  ] }, { $set: { status: 'PROCESSING', leaseUntil: new Date(Date.now() + 60000), leaseToken }, $inc: { attempts: 1 } }, { new: true, sort: { availableAt: 1 } }).select('+email').lean();
  if (!job) return false;
  const owned = { _id: job._id, status: 'PROCESSING', leaseToken };
  const finish = async (status, reason = '', extra = {}) => {
    await Delivery.updateOne(owned, {
      $set: { status, reason, ...extra, ...(status !== 'QUEUED' ? { completedAt: new Date() } : {}) },
      $unset: { leaseToken: 1, leaseUntil: 1, ...(['SENT', 'ACCEPTED', 'SKIPPED'].includes(status) ? { email: 1, providerErrorCode: 1 } : {}) },
    });
  };
  try {
    const order = await Order.findById(job.order).select('+whatsappNotificationConsent').lean();
    if (!eligible(order)) { await finish('SKIPPED', 'ORDER_NO_LONGER_ELIGIBLE'); return true; }
    if (job.channel === 'IN_APP') {
      await notify({ userId: order.user, storeId: order.storeId, event: job.event,
        title: job.event === 'ORDER_PLACED' ? 'Order placed' : 'Payment received',
        message: `Your order ${order.invoiceNumber || ''} ${job.event === 'ORDER_PLACED' ? 'has been placed' : 'is confirmed'}.`,
        metadata: { orderId: String(order._id) },
      });
      await finish('SENT'); return true;
    }
    if (job.channel === 'WHATSAPP') {
      await require('./orderNotificationWhatsapp').processWhatsappDelivery(job, order, owned, finish);
      return true;
    }
    // A previous worker may have died after provider acceptance, before saving.
    const priorAttempt = job.firstAttemptAt && (job.ambiguous || job.email);
    if (priorAttempt && Date.now() - new Date(job.firstAttemptAt).getTime() >= SAFE_RETRY_WINDOW_MS) {
      await finish('UNCERTAIN', 'CHECK_PROVIDER_LOGS'); return true;
    }
    const { settings, adminEmail, store } = await notificationSettings(order.storeId);
    if (settings[job.audience === 'ADMIN' ? 'orderAdminEmailEnabled' : 'orderCustomerEmailEnabled'] === false) {
      await finish('SKIPPED', 'DISABLED_IN_SETTINGS'); return true;
    }
    let recipient = adminEmail;
    if (job.audience === 'CUSTOMER') {
      const customer = await User.findById(order.user).select('email isEmailVerified isBlocked').lean();
      recipient = customer?.isEmailVerified && !customer.isBlocked ? customer.email : '';
      if (!validEmail(recipient)) { await finish('SKIPPED', 'NO_VERIFIED_CUSTOMER_EMAIL'); return true; }
    }
    if (!validEmail(recipient)) { await finish('BLOCKED', 'ADMIN_EMAIL_NOT_CONFIGURED'); return true; }
    if (!emailConfiguration().configured) { await finish('BLOCKED', 'EMAIL_NOT_CONFIGURED'); return true; }
    if (job.email && job.email.to !== recipient) { await finish('UNCERTAIN', 'RECIPIENT_CHANGED_AFTER_ATTEMPT'); return true; }
    if (!job.email) {
      job.email = { to: recipient, ...buildOrderEmail(order, job.audience, settings, store) };
      job.firstAttemptAt = new Date();
    }
    // Re-check after database work and fence the external call. A worker whose
    // lease was taken over must not send with an obsolete claim.
    if (Date.now() - new Date(job.firstAttemptAt).getTime() >= SAFE_RETRY_WINDOW_MS) {
      await finish('UNCERTAIN', 'CHECK_PROVIDER_LOGS'); return true;
    }
    const saved = await Delivery.updateOne(owned, { $set: {
      email: job.email, firstAttemptAt: job.firstAttemptAt, ambiguous: true,
      leaseUntil: new Date(Date.now() + 60000),
    } });
    if (!saved.matchedCount) return true;
    const response = await emailService.sendTransactionalEmail({ ...job.email, idempotencyKey: job.idempotencyKey });
    await finish('ACCEPTED', '', { providerMessageId: String(response?.messageId || '').slice(0, 300), ambiguous: false });
  } catch (error) {
    // Do not persist/log provider bodies: they can contain recipient or secrets.
    const status = Number(error.statusCode || 0);
    const duplicate = error.providerCode === 'duplicate_parameter';
    const ambiguous = job.channel === 'WHATSAPP' ? Boolean(job.ambiguous)
      : job.channel === 'EMAIL' && Boolean(job.firstAttemptAt) && (job.ambiguous || !status || status >= 500 || duplicate);
    const permanent = status >= 400 && status < 500 && status !== 429;
    const reason = duplicate ? 'CHECK_PROVIDER_LOGS' : status === 401 || status === 403 ? 'PROVIDER_AUTH_OR_SENDER_REJECTED'
      : status === 429 ? 'PROVIDER_RATE_LIMIT' : permanent ? 'PROVIDER_REJECTED' : 'TEMPORARY_DELIVERY_FAILURE';
    const nextDelay = RETRY_MS[job.attempts - 1];
    const retryFits = !job.firstAttemptAt || Date.now() + (nextDelay || 0) - new Date(job.firstAttemptAt).getTime() < SAFE_RETRY_WINDOW_MS;
    const retry = !duplicate && !permanent && nextDelay && (!ambiguous || (job.channel === 'EMAIL' && retryFits));
    const finalStatus = duplicate ? 'UNCERTAIN' : retry ? 'QUEUED' : ambiguous ? 'UNCERTAIN' : permanent ? 'BLOCKED' : 'FAILED';
    const finalReason = ambiguous && job.channel === 'WHATSAPP' ? 'CHECK_PROVIDER_LOGS' : reason;
    await finish(finalStatus, finalReason, {
      ambiguous, ...(Number.isSafeInteger(error.providerCode) ? { providerErrorCode: error.providerCode } : {}),
      ...(retry ? { availableAt: new Date(Date.now() + nextDelay) } : {}),
    });
    log('warn', 'Order notification delivery needs attention', { deliveryId: String(job._id), orderId: String(job.order), channel: job.channel, status: finalStatus, reason: finalReason, providerStatus: status || undefined,
      providerErrorCode: Number.isSafeInteger(error.providerCode) ? error.providerCode : undefined });
  }
  return true;
}

let running;
let workerActive = false;
async function runOrderNotificationTick() {
  if (running) return running;
  running = (async () => {
    await recoverOrderNotifications();
    for (let count = 0; count < 20; count += 1) if (!await processNextDelivery()) break;
  })();
  try { await running; } finally { running = null; }
}
function kick() {
  runOrderNotificationTick().catch(() => log('warn', 'Order notification queue will retry on the next worker tick'));
}
function queueOrderNotificationsLater(orderId) {
  if (!workerActive || mongoose.connection.readyState !== 1) return;
  setImmediate(() => {
    queueOrderNotifications(orderId).then(() => { if (workerActive) kick(); })
      .catch(() => log('warn', 'Order notification enqueue deferred to recovery', { orderId }));
  });
}
function startOrderNotificationWorker() {
  workerActive = true;
  kick();
  const timer = setInterval(kick, 30000);
  timer.unref?.();
  return async () => { workerActive = false; clearInterval(timer); if (running) await running.catch(() => null); };
}

module.exports = { queueOrderNotifications, queueOrderNotificationsLater, recoverOrderNotifications, processNextDelivery, runOrderNotificationTick, startOrderNotificationWorker };
