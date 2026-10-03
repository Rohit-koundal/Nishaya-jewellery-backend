const { normalizePhone } = require('../utils/phoneUtils');
const User = require('../models/User');
const Delivery = require('../models/OrderNotificationDelivery');
const { notificationSettings } = require('./orderNotificationEmail');

const env = name => String(process.env[name] || '').trim();
function whatsappNumber(value) {
  if (typeof value !== 'string' || !/^[+\d ()-]+$/.test(value)) return '';
  const normalized = normalizePhone(value);
  return normalized.startsWith('+') ? normalized.slice(1) : normalized ? `91${normalized}` : '';
}

// No tokens/IDs are returned to the browser. Readiness is local validation,
// not proof of template approval, account access or handset delivery.
function whatsappConfiguration(audience) {
  const missing = [], invalid = [];
  const required = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_API_VERSION',
    'WHATSAPP_APP_SECRET', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'WHATSAPP_TEMPLATE_LANGUAGE'];
  const audiences = audience ? [audience] : ['ADMIN', 'CUSTOMER'];
  audiences.forEach(value => required.push(`WHATSAPP_${value}_ORDER_TEMPLATE`));
  for (const key of required) if (!env(key)) missing.push(key);
  const patterns = {
    WHATSAPP_PHONE_NUMBER_ID: /^\d+$/, WHATSAPP_API_VERSION: /^v\d+\.\d+$/,
    WHATSAPP_TEMPLATE_LANGUAGE: /^[a-z]{2,3}(?:_[A-Z]{2})?$/,
    WHATSAPP_ADMIN_ORDER_TEMPLATE: /^[a-z0-9_]{1,512}$/, WHATSAPP_CUSTOMER_ORDER_TEMPLATE: /^[a-z0-9_]{1,512}$/,
  };
  for (const key of required) if (env(key) && patterns[key] && !patterns[key].test(env(key))) invalid.push(key);
  return { provider: 'Meta Cloud API', configured: !missing.length && !invalid.length, missing, invalid };
}

function orderWhatsappConsent(user, requested) {
  const phone = user?.isPhoneVerified && !user.isBlocked ? whatsappNumber(user.phone) : '';
  return requested === true && phone
    ? { granted: true, phone, recordedAt: new Date(), noticeVersion: 'order-confirmation-v1' }
    : { granted: false };
}

function buildWhatsappMessage(order, audience, settings = {}, store) {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 150);
  const payment = order.paymentMethod !== 'COD' ? 'Online payment confirmed'
    : order.codVerification?.status === 'PENDING' ? 'COD - verification pending; payment due on delivery'
      : 'COD - payment due on delivery';
  return {
    name: env(`WHATSAPP_${audience}_ORDER_TEMPLATE`),
    language: { code: env('WHATSAPP_TEMPLATE_LANGUAGE') },
    components: [{ type: 'body', parameters: [
      clean(order.invoiceSeller?.storeName || settings.storeName || store?.name || 'Nishaya Jewellery'),
      clean(order.invoiceNumber || String(order._id).slice(-8).toUpperCase()),
      `INR ${Number(order.finalAmount || 0).toFixed(2)}`, payment,
    ].map(text => ({ type: 'text', text })) }],
  };
}

async function sendWhatsappTemplate({ to, template, correlation }) {
  const response = await fetch(`https://graph.facebook.com/${env('WHATSAPP_API_VERSION')}/${env('WHATSAPP_PHONE_NUMBER_ID')}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${env('WHATSAPP_ACCESS_TOKEN')}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(12000),
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to,
      type: 'template', template, biz_opaque_callback_data: correlation }),
  });
  const data = await response.json().catch(() => null);
  const messageId = data?.messages?.[0]?.id;
  if (!response.ok || data?.error || typeof messageId !== 'string' || !messageId || messageId.length > 300) {
    const error = new Error('WhatsApp provider did not confirm acceptance.');
    // Numeric error codes only. Raw errors may echo phone numbers or tokens.
    error.statusCode = response.ok ? 0 : response.status;
    error.providerCode = Number.isSafeInteger(data?.error?.code) ? data.error.code : undefined;
    throw error;
  }
  return { messageId };
}

async function processWhatsappDelivery(job, order, owned, finish) {
  // Meta /messages has no idempotency guarantee here. Never replay a send
  // after a crashed worker or ambiguous response; wait for signed webhooks.
  if (job.ambiguous || job.firstAttemptAt) { await finish('UNCERTAIN', 'CHECK_PROVIDER_LOGS'); return; }
  const { settings, store } = await notificationSettings(order.storeId);
  if (settings[job.audience === 'ADMIN' ? 'orderAdminWhatsappEnabled' : 'orderCustomerWhatsappEnabled'] !== true) {
    await finish('SKIPPED', 'DISABLED_IN_SETTINGS'); return;
  }
  let recipient = whatsappNumber(settings.orderNotificationWhatsapp || '');
  if (job.audience === 'CUSTOMER') {
    const consent = order.whatsappNotificationConsent;
    const customer = await User.findById(order.user).select('phone isPhoneVerified isBlocked').lean();
    recipient = customer?.isPhoneVerified && !customer.isBlocked ? whatsappNumber(customer.phone) : '';
    if (!consent?.granted || !recipient || recipient !== consent.phone) {
      await finish('SKIPPED', 'NO_CUSTOMER_WHATSAPP_CONSENT'); return;
    }
  }
  if (!recipient) { await finish('BLOCKED', 'ADMIN_WHATSAPP_NOT_CONFIGURED'); return; }
  if (!whatsappConfiguration(job.audience).configured) { await finish('BLOCKED', 'WHATSAPP_NOT_CONFIGURED'); return; }
  const template = buildWhatsappMessage(order, job.audience, settings, store);
  job.firstAttemptAt = new Date();
  job.ambiguous = true;
  const saved = await Delivery.updateOne(owned, { $set: {
    firstAttemptAt: job.firstAttemptAt, ambiguous: true, whatsappPhoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
    leaseUntil: new Date(Date.now() + 60000),
  } });
  if (!saved.matchedCount) return;
  let response;
  try {
    response = await module.exports.sendWhatsappTemplate({ to: recipient, template, correlation: job.idempotencyKey });
  } catch (error) {
    // A definitive 4xx rejects the request; timeout/5xx is NOT safe to retry.
    const status = Number(error.statusCode || 0);
    if (status >= 400 && status < 500) {
      job.ambiguous = false; job.firstAttemptAt = null;
      await Delivery.updateOne(owned, { $set: { ambiguous: false }, $unset: { firstAttemptAt: 1 } });
    }
    throw error;
  }
  await finish('ACCEPTED', '', { providerMessageId: response.messageId, ambiguous: false });
}

module.exports = { whatsappConfiguration, whatsappNumber, orderWhatsappConsent, buildWhatsappMessage, sendWhatsappTemplate, processWhatsappDelivery };
