const { readConfiguration, requireConfiguration, providerError, otpRecipient, requestJson } = require('./smsProviderUtils');

function getConfiguration() {
  return readConfiguration({ apiKey: ['MSG91_AUTH_KEY', 'SMS_API_KEY'], templateId: ['MSG91_TEMPLATE_ID', 'SMS_TEMPLATE_ID'] });
}

async function sendOtp(phone, otp) {
  const { apiKey, templateId } = requireConfiguration(getConfiguration());
  const mobile = otpRecipient(phone, otp).slice(1);
  const url = new URL('https://control.msg91.com/api/v5/otp');
  url.search = new URLSearchParams({ template_id: templateId, mobile, otp: String(otp), otp_length: '6' }).toString();
  const { response, data } = await requestJson(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authkey: apiKey,
    },
    body: JSON.stringify({}),
  });

  if (!response.ok || data?.type !== 'success') {
    const authFailed = response.status === 401 || response.status === 403 || /invalid auth(?:key|entication key)|auth(?:key|entication key) (?:is )?invalid|authentication failed|unauthori[sz]ed/i.test(String(data?.message || ''));
    throw providerError(authFailed ? 'OTP_PROVIDER_AUTH_FAILED' : 'OTP_DELIVERY_UNAVAILABLE');
  }
  return { success: true, provider: 'msg91' };
}

module.exports = { sendOtp, getConfiguration };
