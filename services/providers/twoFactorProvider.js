const { readConfiguration, requireConfiguration, providerError, otpRecipient, requestJson } = require('./smsProviderUtils');

function getConfiguration() {
  const mode = String(process.env.TWOFACTOR_DELIVERY_MODE || '').trim().toLowerCase() || 'otp';
  const transactional = mode === 'transactional_sms';
  const configuration = transactional
    ? readConfiguration({
      apiKey: ['TWOFACTOR_API_KEY'], sender: ['TWOFACTOR_SMS_SENDER_ID'], message: ['TWOFACTOR_SMS_TEMPLATE'],
    }, { entityId: ['TWOFACTOR_DLT_ENTITY_ID'], templateId: ['TWOFACTOR_DLT_TEMPLATE_ID'] })
    : readConfiguration({ apiKey: ['TWOFACTOR_API_KEY'] }, { template: ['TWOFACTOR_TEMPLATE_NAME'] });
  const invalid = [];
  if (!['otp', 'transactional_sms'].includes(mode)) invalid.push('TWOFACTOR_DELIVERY_MODE');
  if (transactional) {
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
  }
  return { ...configuration, invalid, deliveryMode: ['otp', 'transactional_sms'].includes(mode) ? mode : 'invalid' };
}

async function sendOtp(phone, otp) {
  const configuration = getConfiguration();
  const { apiKey, template, sender, message, entityId, templateId } = requireConfiguration(configuration);
  const recipient = otpRecipient(phone, otp, { indiaOnly: true });
  let result;
  if (configuration.deliveryMode === 'transactional_sms') {
    // Dedicated transactional SMS transport, distinct from the provider-managed OTP
    // product. Never fall back to /SMS/, /VOICE/, AUTOGEN or another provider.
    // https://documenter.getpostman.com/view/301893/TWDamFGh (Send Single SMS)
    const body = new URLSearchParams({
      module: 'TRANS_SMS', apikey: apiKey, to: recipient.slice(1), from: sender,
      msg: message.replace('{otp}', String(otp)),
    });
    if (entityId) body.set('peid', entityId);
    if (templateId) body.set('ctid', templateId);
    result = await requestJson('https://2factor.in/API/R1/', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
  } else {
    // Preserve existing installations until a DLT-approved transactional SMS
    // setup is available. This /SMS/ route can still be routed by the provider.
    // API keys/OTPs are in its URL contract, so never log this URL or the body above.
    const segments = [apiKey, 'SMS', recipient, String(otp), ...(template ? [template] : [])];
    result = await requestJson(`https://2factor.in/API/V1/${segments.map(encodeURIComponent).join('/')}`, { method: 'POST' });
  }
  const { response, data } = result;
  if (!response.ok || data?.Status !== 'Success' || typeof data?.Details !== 'string' || !data.Details.trim()) {
    const authFailed = response.status === 401 || response.status === 403 || /invalid api key|authentication failed|unauthori[sz]ed/i.test(String(data?.Details || ''));
    throw providerError(authFailed ? 'OTP_PROVIDER_AUTH_FAILED' : 'OTP_DELIVERY_UNAVAILABLE');
  }
  return { success: true, provider: '2factor' };
}

module.exports = { sendOtp, getConfiguration };
