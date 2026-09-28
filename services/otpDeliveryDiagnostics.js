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

// Preserve useful provider evidence without dumping an untrusted response that
// can echo an API key, SMS body or OTP. Only known status/error text is retained;
// unknown/free-form details and extra response fields are deliberately omitted.
function safeProviderResponse(data, sensitive = []) {
  const safe = value => !sensitive.some(secret => secret && value.toLowerCase().includes(String(secret).toLowerCase()));
  const providerStatus = ['Success', 'Error'].includes(data?.Status) && safe(data.Status) ? data.Status : null;
  const details = typeof data?.Details === 'string' ? data.Details.slice(0, 4096) : '';
  const match = details.match(/\b(DLT-CNT-REJECT|Invalid API Key(?: - No Account Exists)?|Authentication failed|Unauthorized|Sender (?:id )?not approved|Content template mismatch|PE-TM chain mapping required|Balance too low|Insufficient (?:balance|credits)|Account (?:disabled|inactive|expired)|Too many requests)\b/i);
  const providerDetails = match && safe(match[0]) ? match[0] : null;
  return {
    providerStatus,
    providerCode: providerDetails?.toUpperCase() === 'DLT-CNT-REJECT' ? 'DLT-CNT-REJECT' : null,
    providerDetails,
    providerDetailsRedacted: typeof data?.Details !== 'string' || data.Details !== providerDetails,
  };
}

function createDeliveryAttempt({ apiKey, requestId, deliveryMode = 'transactional_sms', sensitive = [] }) {
  const startedAt = Date.now();
  const supportReference = crypto.randomUUID();
  const safeRequestId = UUID.test(String(requestId || '')) ? safeProviderReference(requestId, [apiKey, ...sensitive]) : null;
  const safeMode = ['transactional_sms', 'otp_sms'].includes(deliveryMode) ? deliveryMode : 'invalid';
  const base = { supportReference, provider: '2factor', channel: 'sms', deliveryMode: safeMode, accountFingerprint: accountFingerprint(apiKey) };
  return {
    finish(status, { reference, reason = null, httpStatus, providerResponse } = {}) {
      const providerReference = safeProviderReference(reference, [apiKey, ...sensitive]);
      const delivery = {
        ...base, status, providerReference,
        reason: reason || (status === 'accepted' && !providerReference ? 'REFERENCE_UNAVAILABLE' : null), attemptedAt: new Date(startedAt).toISOString(),
      };
      // Allowlisted fields only. No provider body, URL, message, recipient or OTP.
      console.info(JSON.stringify({
        ts: new Date().toISOString(), level: status === 'accepted' ? 'info' : 'warn',
        event: 'otp.delivery', ...delivery, ...(safeRequestId ? { requestId: safeRequestId } : {}),
        ...(providerResponse !== undefined ? safeProviderResponse(providerResponse, [apiKey, ...sensitive]) : {}),
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

module.exports = { accountFingerprint, createDeliveryAttempt, publicDelivery, rememberDelivery, safeProviderReference, safeProviderResponse };
