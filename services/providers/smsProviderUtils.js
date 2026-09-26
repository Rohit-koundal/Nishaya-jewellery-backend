const { requireValidPhone } = require('../../utils/phoneUtils');

// Configuration is resolved at call time; existing SMS_* deployments keep working.
function readConfiguration(required, optional = {}) {
  const values = {};
  const missing = [];
  for (const [field, names] of Object.entries({ ...required, ...optional })) {
    values[field] = names.map(name => String(process.env[name] || '').trim()).find(Boolean) || '';
    if (Object.hasOwn(required, field) && !values[field]) missing.push(names.join(' or '));
  }
  return { values, missing };
}

function providerError(code = 'OTP_DELIVERY_UNAVAILABLE', providerCode) {
  const messages = {
    OTP_PROVIDER_NOT_CONFIGURED: 'SMS provider configuration is incomplete.',
    OTP_PROVIDER_AUTH_FAILED: 'SMS provider rejected the credentials or permissions.',
    OTP_DELIVERY_UNAVAILABLE: 'SMS provider could not accept the OTP. Please try again shortly.',
  };
  const error = new Error(messages[code] || messages.OTP_DELIVERY_UNAVAILABLE);
  error.errorCode = Object.hasOwn(messages, code) ? code : 'OTP_DELIVERY_UNAVAILABLE';
  error.statusCode = 503;
  // Never propagate provider text, request URLs, phone numbers, OTPs or credentials.
  if (providerCode !== undefined && /^\d{1,8}$/.test(String(providerCode))) error.providerCode = Number(providerCode);
  return error;
}

function requireConfiguration(configuration) {
  if (configuration.missing.length) throw providerError('OTP_PROVIDER_NOT_CONFIGURED');
  return configuration.values;
}

function otpRecipient(phone, otp, { indiaOnly = false } = {}) {
  let normalized;
  try { normalized = requireValidPhone(phone); } catch { throw providerError(); }
  if (!/^\d{6}$/.test(String(otp)) || (indiaOnly && normalized.startsWith('+'))) throw providerError();
  return normalized.startsWith('+') ? normalized : `+91${normalized}`;
}

async function requestJson(url, options) {
  const configured = Number(process.env.SMS_REQUEST_TIMEOUT_MS);
  const timeout = Number.isFinite(configured) && configured > 0 ? Math.min(30000, Math.max(1000, configured)) : 15000;
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeout) });
    const data = await response.json().catch(() => null);
    return { response, data };
  } catch {
    // No automatic retry: a timeout can happen after the provider accepted the SMS.
    throw providerError();
  }
}

module.exports = { readConfiguration, requireConfiguration, providerError, otpRecipient, requestJson };
