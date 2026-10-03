const crypto = require('crypto');
const Delivery = require('../models/OrderNotificationDelivery');
const { asyncHandler } = require('../middleware/validate');

function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || !expected) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

exports.verify = (req, res) => {
  if (req.query['hub.mode'] !== 'subscribe'
      || !equalSecret(req.query['hub.verify_token'], process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim())
      || typeof req.query['hub.challenge'] !== 'string') return res.sendStatus(403);
  return res.status(200).type('text/plain').send(req.query['hub.challenge']);
};

exports.receive = asyncHandler(async (req, res) => {
  const secret = process.env.WHATSAPP_APP_SECRET?.trim();
  if (!secret) return res.sendStatus(503);
  if (!Buffer.isBuffer(req.body)) return res.sendStatus(400);
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(req.body).digest('hex')}`;
  if (!equalSecret(req.get('x-hub-signature-256'), expected)) return res.sendStatus(401);
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
  if (payload?.object !== 'whatsapp_business_account') return res.sendStatus(200);
  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== 'messages') continue;
      const value = change.value;
      const phoneId = value?.metadata?.phone_number_id;
      if (typeof phoneId !== 'string') continue;
      for (const update of Array.isArray(value?.statuses) ? value.statuses : []) {
        if (typeof update?.id !== 'string' || !update.id || update.id.length > 300
            || !['sent', 'delivered', 'read', 'failed'].includes(update.status)) continue;
        const status = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' }[update.status];
        if (!status) continue;
        const correlation = update.biz_opaque_callback_data;
        const byMessage = { providerMessageId: update.id };
        const identity = typeof correlation === 'string' && /^[\da-f-]{36}$/i.test(correlation)
          ? { idempotencyKey: correlation, $or: [byMessage, { providerMessageId: { $exists: false } }] }
          : byMessage;
        // Do not downgrade delivered/read when Meta retries older status events.
        const from = ['PROCESSING', 'ACCEPTED', 'UNCERTAIN'];
        if (status !== 'SENT') from.push('SENT');
        if (status === 'DELIVERED' || status === 'READ') from.push('FAILED');
        if (status === 'READ') from.push('DELIVERED');
        const code = update.errors?.[0]?.code;
        await Delivery.updateOne({ ...identity, channel: 'WHATSAPP', whatsappPhoneNumberId: phoneId, status: { $in: from } }, {
          $set: { status, providerMessageId: update.id, ambiguous: false, completedAt: new Date(),
            reason: status === 'FAILED' ? 'WHATSAPP_DELIVERY_FAILED' : '',
            ...(status === 'FAILED' && Number.isSafeInteger(code) ? { providerErrorCode: code } : {}) },
          $unset: { leaseUntil: 1, leaseToken: 1, ...(status !== 'FAILED' ? { providerErrorCode: 1 } : {}) },
        });
      }
    }
  }
  // Never persist or log inbound messages, recipients or raw webhook payloads.
  return res.sendStatus(200);
});
