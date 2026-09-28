const crypto = require('node:crypto');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// R1 returns a hex reference; older transactional sessions use UUIDs. Never
// treat arbitrary provider text as a reference (it can contain credentials/OTP).
function safeProviderReference(value, sensitive = []) {
  if (typeof value !== 'string') return null;
  const reference = value.trim();
  if (!/^[a-f0-9]{16,64}$/i.test(reference) && !UUID.test(reference)) return null;
  if (sensitive.some(secret => secret && reference.toLowerCase().includes(String(secret).toLowerCase()))) return null;
  return reference;
}

function accountFingerprint(key) {
  return key ? crypto.createHash('sha256').update(String(key).trim()).digest('hex').slice(0, 16) : null;
}

function createDeliveryAttempt({ apiKey, requestId, sensitive = [] }) {
  const startedAt = Date.now();
  const supportReference = crypto.randomUUID();
  const safeRequestId = UUID.test(String(requestId || '')) ? safeProviderReference(requestId, [apiKey, ...sensitive]) : null;
  const base = { supportReference, provider: '2factor', channel: 'sms', deliveryMode: 'transactional_sms', accountFingerprint: accountFingerprint(apiKey) };
  return {
    finish(status, { reference, reason = null, httpStatus } = {}) {
      const providerReference = safeProviderReference(reference, [apiKey, ...sensitive]);
      const delivery = {
        ...base, status, providerReference,
        reason: reason || (status === 'accepted' && !providerReference ? 'REFERENCE_UNAVAILABLE' : null), attemptedAt: new Date(startedAt).toISOString(),
      };
      // Allowlisted fields only. No provider body, URL, message, recipient or OTP.
      console.info(JSON.stringify({
        ts: new Date().toISOString(), level: status === 'accepted' ? 'info' : 'warn',
        event: 'otp.delivery', ...delivery, ...(safeRequestId ? { requestId: safeRequestId } : {}),
        ...(Number.isInteger(httpStatus) ? { httpStatus } : {}), durationMs: Date.now() - startedAt,
      }));
      return delivery;
    },
  };
}

function publicDelivery(delivery) {
  if (!delivery || !UUID.test(String(delivery.supportReference || '')) || !['accepted', 'rejected', 'unknown'].includes(delivery.status)) return {};
  return { supportReference: delivery.supportReference, deliveryStatus: delivery.status };
}

// Persist against the existing, expiring OTP record; provider IDs also remain
// in deployment logs for support after the OTP expires. Never store plaintext.
async function rememberDelivery(record, delivery) {
  if (!record || !delivery) return;
  try {
    record.delivery = delivery;
    await record.save();
  } catch {
    // A metadata write failure must not send a second SMS or destroy a valid OTP.
    console.info(JSON.stringify({ event: 'otp.delivery_metadata_unavailable', supportReference: delivery.supportReference }));
  }
}

module.exports = { accountFingerprint, createDeliveryAttempt, publicDelivery, rememberDelivery, safeProviderReference };
