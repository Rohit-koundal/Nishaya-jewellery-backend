const { readConfiguration, requireConfiguration, providerError, otpRecipient, requestJson } = require('./smsProviderUtils');
const { createDeliveryAttempt, safeProviderResponse } = require('../otpDeliveryDiagnostics');

function getConfiguration() {
  // This adapter has one transport only. A legacy/unknown explicit mode must
  // fail closed rather than re-enable the provider-managed OTP product.
  const mode = String(process.env.TWOFACTOR_DELIVERY_MODE || '').trim().toLowerCase() || 'transactional_sms';
  const configuration = readConfiguration({
    apiKey: ['TWOFACTOR_API_KEY'], sender: ['TWOFACTOR_SMS_SENDER_ID'], message: ['TWOFACTOR_SMS_TEMPLATE'],
  }, {
    // Optional in the official R1 contract. Do not impose an extra local
    // registration gate; provider-side sender/content approval still applies.
    entityId: ['TWOFACTOR_DLT_ENTITY_ID'], templateId: ['TWOFACTOR_DLT_TEMPLATE_ID'],
  });
  const invalid = [];
  if (mode !== 'transactional_sms') invalid.push('TWOFACTOR_DELIVERY_MODE');
  // DLT content must be sent exactly as approved, including whitespace. Only
  // the application's single {otp} placeholder is substituted at send time.
  configuration.values.message = String(process.env.TWOFACTOR_SMS_TEMPLATE || '');
  const { sender, message, entityId, templateId } = configuration.values;
  if (sender && !/^[a-z]{3,6}$/i.test(sender)) invalid.push('TWOFACTOR_SMS_SENDER_ID');
  if (message.trim() && ((message.match(/\{otp\}/g) || []).length !== 1 || /[{}]/.test(message.replace('{otp}', '')) || /#VAR\d+#/i.test(message))) {
    invalid.push('TWOFACTOR_SMS_TEMPLATE');
  }
  if (entityId && !/^\d{1,64}$/.test(entityId)) invalid.push('TWOFACTOR_DLT_ENTITY_ID');
  if (templateId && !/^\d{1,64}$/.test(templateId)) invalid.push('TWOFACTOR_DLT_TEMPLATE_ID');
  return { ...configuration, invalid, deliveryMode: mode === 'transactional_sms' ? mode : 'invalid' };
}

async function sendOtp(phone, otp, { requestId } = {}) {
  const configuration = getConfiguration();
  const { apiKey, sender, message, entityId, templateId } = requireConfiguration(configuration);
  const recipient = otpRecipient(phone, otp, { indiaOnly: true });
  const attempt = createDeliveryAttempt({ apiKey, requestId, sensitive: [String(otp), recipient, recipient.slice(1), recipient.slice(-10)] });
  // Dedicated transactional SMS only; never fall back to the OTP/voice product.
  // https://documenter.getpostman.com/view/301893/TWDamFGh (Send Single SMS)
  const body = new URLSearchParams({
    module: 'TRANS_SMS', apikey: apiKey, to: recipient.slice(1), from: sender,
    msg: message.replace('{otp}', String(otp)),
  });
  if (entityId) body.set('peid', entityId);
  if (templateId) body.set('ctid', templateId);
  // Safe route diagnostic only: never log the key, recipient, OTP or request body.
  console.info('[2Factor] deliveryMode:', configuration.deliveryMode);
  let result;
  try {
    result = await requestJson('https://2factor.in/API/R1/', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
  } catch (error) {
    error.delivery = attempt.finish('unknown', { reason: 'NETWORK_OR_TIMEOUT' });
    throw error;
  }
  const { response, data } = result;
  const reportedRejection = safeProviderResponse(data).providerCode === 'DLT-CNT-REJECT';
  if (!response.ok || data?.Status !== 'Success' || typeof data?.Details !== 'string' || !data.Details.trim() || reportedRejection) {
    const authFailed = response.status === 401 || response.status === 403 || /invalid api key|authentication failed|unauthori[sz]ed/i.test(String(data?.Details || ''));
    const error = providerError(authFailed ? 'OTP_PROVIDER_AUTH_FAILED' : 'OTP_DELIVERY_UNAVAILABLE');
    const reason = failureReason(data?.Details, response.status, authFailed);
    error.delivery = attempt.finish(reportedRejection || data?.Status === 'Error' || (response.status >= 400 && response.status < 500) ? 'rejected' : 'unknown', { reason, httpStatus: response.status, providerResponse: data });
    throw error;
  }
  const delivery = attempt.finish('accepted', { reference: data.Details, httpStatus: response.status, providerResponse: data });
  // Provider acceptance of the requested channel is not a handset delivery receipt.
  return { success: true, provider: '2factor', channel: 'sms', delivery };
}

function failureReason(details, status, authFailed) {
  if (authFailed) return 'AUTH_OR_PERMISSION';
  if (status === 429) return 'PROVIDER_RATE_LIMIT';
  const text = typeof details === 'string' ? details.slice(0, 4096).toLowerCase() : '';
  if (/\bdlt-cnt-reject\b/.test(text)) return 'DLT_CONTENT_REJECTED';
  if (/balance|credit|insufficient/.test(text)) return 'INSUFFICIENT_BALANCE';
  if (/sender|header/.test(text)) return 'SENDER_NOT_APPROVED';
  if (/template|content.*mismatch/.test(text)) return 'TEMPLATE_REJECTED';
  if (/dlt|entity|peid|ctid|mapping|chain/.test(text)) return 'DLT_CONFIGURATION';
  if (/inactive|disabled|expired/.test(text)) return 'SERVICE_INACTIVE';
  return status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED_OR_INVALID_RESPONSE';
}

module.exports = { sendOtp, getConfiguration };
