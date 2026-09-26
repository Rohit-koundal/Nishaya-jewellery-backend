const { readConfiguration, requireConfiguration, providerError, otpRecipient, requestJson } = require('./smsProviderUtils');

function getConfiguration() {
  return readConfiguration({ apiKey: ['TWOFACTOR_API_KEY'] }, { template: ['TWOFACTOR_TEMPLATE_NAME'] });
}

async function sendOtp(phone, otp) {
  const { apiKey, template } = requireConfiguration(getConfiguration());
  const recipient = otpRecipient(phone, otp, { indiaOnly: true });
  // Manual OTP endpoint: the same backend-generated code is verified by otpService.
  // API keys/OTPs are in the provider's URL contract, so never log this URL.
  const segments = [apiKey, 'SMS', recipient, String(otp), ...(template ? [template] : [])];
  const { response, data } = await requestJson(`https://2factor.in/API/V1/${segments.map(encodeURIComponent).join('/')}`, { method: 'POST' });
  if (!response.ok || data?.Status !== 'Success' || typeof data?.Details !== 'string' || !data.Details.trim()) {
    const authFailed = response.status === 401 || response.status === 403 || /invalid api key|authentication failed|unauthori[sz]ed/i.test(String(data?.Details || ''));
    throw providerError(authFailed ? 'OTP_PROVIDER_AUTH_FAILED' : 'OTP_DELIVERY_UNAVAILABLE');
  }
  return { success: true, provider: '2factor' };
}

module.exports = { sendOtp, getConfiguration };
