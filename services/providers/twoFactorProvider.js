const { readConfiguration, requireConfiguration, providerError, otpRecipient, requestJson } = require('./smsProviderUtils');
const { createDeliveryAttempt, safeProviderResponse } = require('../otpDeliveryDiagnostics');

const SUPPORTED_DELIVERY_MODES = Object.freeze(['transactional_sms', 'otp_sms']);

function getDeliveryMode() {
  const selected = String(process.env.TWOFACTOR_DELIVERY_MODE || '').trim().toLowerCase() || 'transactional_sms';
  const mode = selected === 'sms_otp' ? 'otp_sms' : selected;
  return SUPPORTED_DELIVERY_MODES.includes(mode) ? mode : 'invalid';
}

function getConfiguration() {
  // Read at request time, not module import. A mode switch never reuses the
  // other product's configuration or silently falls back to its endpoint.
  const mode = getDeliveryMode();
  if (mode === 'invalid') return { values: {}, missing: [], invalid: ['TWOFACTOR_DELIVERY_MODE'], deliveryMode: mode, supportedDeliveryModes: SUPPORTED_DELIVERY_MODES };
  if (mode === 'otp_sms') {
    const configuration = readConfiguration({
      apiKey: ['TWOFACTOR_API_KEY'], templateName: ['TWOFACTOR_TEMPLATE_NAME'],
      smsOnlyConfirmed: ['TWOFACTOR_OTP_SMS_ONLY_CONFIRMED'],
    });
    const invalid = [];
    const { templateName, smsOnlyConfirmed } = configuration.values;
    if (templateName && !/^[a-z\d][a-z\d _-]{0,99}$/i.test(templateName)) invalid.push('TWOFACTOR_TEMPLATE_NAME');
    // This is an operator attestation AFTER 2Factor disables voice fallback for
    // this account. It is not an API parameter and cannot disable provider calls.
    if (smsOnlyConfirmed && smsOnlyConfirmed.toLowerCase() !== 'true') invalid.push('TWOFACTOR_OTP_SMS_ONLY_CONFIRMED');
    return { ...configuration, invalid, deliveryMode: mode, supportedDeliveryModes: SUPPORTED_DELIVERY_MODES };
  }
  const configuration = readConfiguration({
    apiKey: ['TWOFACTOR_API_KEY'], sender: ['TWOFACTOR_SMS_SENDER_ID'], message: ['TWOFACTOR_SMS_TEMPLATE'],
  }, {
    // Optional in the official R1 contract. Do not impose an extra local
    // registration gate; provider-side sender/content approval still applies.
    entityId: ['TWOFACTOR_DLT_ENTITY_ID'], templateId: ['TWOFACTOR_DLT_TEMPLATE_ID'],
  });
  const invalid = [];
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
  return { ...configuration, invalid, deliveryMode: mode, supportedDeliveryModes: SUPPORTED_DELIVERY_MODES };
}

function buildRequest(mode, { apiKey, sender, message, entityId, templateId, templateName }, recipient, otp) {
  if (mode === 'otp_sms') {
    // Official "Send OTP (Manual Generation)": keep backend-generated OTP and
    // verification unchanged. URL contains secrets; never log it or fetch errors.
    const segments = [apiKey, 'SMS', recipient, String(otp), templateName].map(encodeURIComponent);
    return { url: `https://2factor.in/API/V1/${segments.join('/')}`, options: { method: 'GET', cache: 'no-store', headers: { Accept: 'application/json' } } };
  }
  // Official "Send Single SMS". No voice endpoint or cross-mode retry.
  const body = new URLSearchParams({
    module: 'TRANS_SMS', apikey: apiKey, to: recipient.slice(1), from: sender,
    msg: message.replace('{otp}', String(otp)),
  });
  if (entityId) body.set('peid', entityId);
  if (templateId) body.set('ctid', templateId);
  return { url: 'https://2factor.in/API/R1/', options: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body } };
}

async function sendOtp(phone, otp, { requestId } = {}) {
  const configuration = getConfiguration();
  const values = requireConfiguration(configuration);
  const recipient = otpRecipient(phone, otp, { indiaOnly: true });
  const attempt = createDeliveryAttempt({ apiKey: values.apiKey, requestId, deliveryMode: configuration.deliveryMode, sensitive: [String(otp), recipient, recipient.slice(1), recipient.slice(-10)] });
  const request = buildRequest(configuration.deliveryMode, values, recipient, otp);
  // Safe route diagnostic only: never log the key, recipient, OTP or request body.
  console.info('[2Factor] deliveryMode:', configuration.deliveryMode);
  let result;
  try {
    result = await requestJson(request.url, request.options);
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

module.exports = { sendOtp, getConfiguration, getDeliveryMode };
