const { readConfiguration, requireConfiguration, providerError, otpRecipient, requestJson } = require('./smsProviderUtils');

function getConfiguration() {
  return readConfiguration({ apiKey: ['FAST2SMS_API_KEY', 'SMS_API_KEY'] }, { senderId: ['FAST2SMS_SENDER_ID', 'SMS_SENDER_ID'] });
}

async function sendOtp(phone, otp) {
  const { apiKey, senderId } = requireConfiguration(getConfiguration());
  const recipient = otpRecipient(phone, otp, { indiaOnly: true }).slice(3);
  const { response, data } = await requestJson('https://www.fast2sms.com/dev/bulkV2', {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      route: 'otp',
      variables_values: otp,
      numbers: recipient,
      sender_id: senderId || undefined,
    }),
  });

  if (!response.ok || data?.return !== true) {
    throw providerError(response.status === 401 || response.status === 403 ? 'OTP_PROVIDER_AUTH_FAILED' : 'OTP_DELIVERY_UNAVAILABLE');
  }
  return { success: true, provider: 'fast2sms' };
}

module.exports = { sendOtp, getConfiguration };
