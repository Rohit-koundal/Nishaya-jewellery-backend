const { readConfiguration, requireConfiguration, providerError, otpRecipient, requestJson } = require('./smsProviderUtils');

function getConfiguration() {
  // This adapter has one transport only. A legacy/unknown explicit mode must
  // fail closed rather than re-enable the provider-managed OTP product.
  const mode = String(process.env.TWOFACTOR_DELIVERY_MODE || '').trim().toLowerCase() || 'transactional_sms';
  const configuration = readConfiguration({
    apiKey: ['TWOFACTOR_API_KEY'], sender: ['TWOFACTOR_SMS_SENDER_ID'], message: ['TWOFACTOR_SMS_TEMPLATE'],
  }, { entityId: ['TWOFACTOR_DLT_ENTITY_ID'], templateId: ['TWOFACTOR_DLT_TEMPLATE_ID'] });
  const invalid = [];
  if (mode !== 'transactional_sms') invalid.push('TWOFACTOR_DELIVERY_MODE');
  // DLT content must be sent exactly as approved, including whitespace. Only
  // the application's single {otp} placeholder is substituted at send time.
  configuration.values.message = String(process.env.TWOFACTOR_SMS_TEMPLATE || '');
  const { sender, message, entityId, templateId } = configuration.values;
  if (sender && !/^[a-z]{6}$/i.test(sender)) invalid.push('TWOFACTOR_SMS_SENDER_ID');
  if (message.trim() && ((message.match(/\{otp\}/g) || []).length !== 1 || /[{}]/.test(message.replace('{otp}', '')))) {
    invalid.push('TWOFACTOR_SMS_TEMPLATE');
  }
  if (entityId && !/^\d{1,64}$/.test(entityId)) invalid.push('TWOFACTOR_DLT_ENTITY_ID');
  if (templateId && !/^\d{1,64}$/.test(templateId)) invalid.push('TWOFACTOR_DLT_TEMPLATE_ID');
  return { ...configuration, invalid, deliveryMode: mode === 'transactional_sms' ? mode : 'invalid' };
}

async function sendOtp(phone, otp) {
  const configuration = getConfiguration();
  const { apiKey, sender, message, entityId, templateId } = requireConfiguration(configuration);
  const recipient = otpRecipient(phone, otp, { indiaOnly: true });
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
  const { response, data } = await requestJson('https://2factor.in/API/R1/', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!response.ok || data?.Status !== 'Success' || typeof data?.Details !== 'string' || !data.Details.trim()) {
    const authFailed = response.status === 401 || response.status === 403 || /invalid api key|authentication failed|unauthori[sz]ed/i.test(String(data?.Details || ''));
    throw providerError(authFailed ? 'OTP_PROVIDER_AUTH_FAILED' : 'OTP_DELIVERY_UNAVAILABLE');
  }
  // Provider acceptance of the requested channel is not a handset delivery receipt.
  return { success: true, provider: '2factor', channel: 'sms' };
}

module.exports = { sendOtp, getConfiguration };
