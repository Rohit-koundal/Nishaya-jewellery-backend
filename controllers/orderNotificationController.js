const crypto = require('crypto');
const Delivery = require('../models/OrderNotificationDelivery');
const { asyncHandler } = require('../middleware/validate');
const { ApiError } = require('../utils/apiError');
const { requireObjectId } = require('../utils/validators');
const { emailConfiguration, notificationSettings, scopeFor } = require('../services/orderNotificationEmail');
const { logAudit } = require('../services/auditService');
const { whatsappConfiguration } = require('../services/orderNotificationWhatsapp');

exports.status = asyncHandler(async (req, res) => {
  const storeId = req.store?._id;
  const [{ settings, adminEmail }, items] = await Promise.all([
    notificationSettings(storeId),
    Delivery.find(scopeFor(storeId, req.isDefaultStore || req.store?.isDefault)).sort({ createdAt: -1 }).limit(30)
      .select('order event channel audience status reason attempts ambiguous providerErrorCode createdAt updatedAt').lean(),
  ]);
  res.json({
    ...emailConfiguration(), inApp: true,
    whatsapp: { ...whatsappConfiguration(),
      adminConfigured: whatsappConfiguration('ADMIN').configured, customerConfigured: whatsappConfiguration('CUSTOMER').configured,
      adminEnabled: settings.orderAdminWhatsappEnabled === true, customerEnabled: settings.orderCustomerWhatsappEnabled === true,
      adminRecipient: settings.orderNotificationWhatsapp ? `Ending ${settings.orderNotificationWhatsapp.replace(/\D/g, '').slice(-4)}` : '',
    },
    adminEmail, adminEnabled: settings.orderAdminEmailEnabled !== false,
    customerEnabled: settings.orderCustomerEmailEnabled !== false,
    items: items.map(({ ambiguous, ...item }) => ({ ...item, canRetry: !ambiguous && ['BLOCKED', 'FAILED'].includes(item.status) })),
  });
});

exports.retry = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'notification delivery');
  const scope = scopeFor(req.store?._id, req.isDefaultStore || req.store?.isDefault);
  const existing = await Delivery.findOne({ _id: id, ...scope }).select('channel audience').lean();
  if (!existing) throw new ApiError('NOT_FOUND', 'Delivery not found.');
  if (existing.channel === 'WHATSAPP' ? !whatsappConfiguration(existing.audience).configured : !emailConfiguration().configured) {
    throw new ApiError('SERVICE_UNAVAILABLE', `Configure ${existing.channel === 'WHATSAPP' ? 'WhatsApp' : 'Brevo'} before retrying alerts.`);
  }
  const job = await Delivery.findOneAndUpdate({
    _id: id, ...scopeFor(req.store?._id, req.isDefaultStore || req.store?.isDefault), status: { $in: ['BLOCKED', 'FAILED'] }, ambiguous: false,
  }, {
    $set: { status: 'QUEUED', reason: '', attempts: 0, availableAt: new Date(), idempotencyKey: crypto.randomUUID() },
    $unset: { firstAttemptAt: 1, email: 1, completedAt: 1, leaseUntil: 1, leaseToken: 1, providerMessageId: 1, providerErrorCode: 1, whatsappPhoneNumberId: 1 },
  }, { new: true });
  if (!job) throw new ApiError('NOT_FOUND', 'Delivery not found or cannot safely be retried. Check provider logs for uncertain delivery.');
  await logAudit({ req, action: 'ORDER_NOTIFICATION_RETRY', entityType: 'OrderNotificationDelivery', entityId: job._id, storeId: job.storeId });
  res.json({ success: true, message: 'Alert queued for retry. The worker will process it shortly.' });
});
