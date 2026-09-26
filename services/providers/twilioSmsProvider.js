const { readConfiguration, requireConfiguration, providerError, otpRecipient, requestJson } = require('./smsProviderUtils');

async function sendOtp(phone, otp) {
  const config = requireConfiguration(getConfiguration());

  const body = new URLSearchParams({
    To: otpRecipient(phone, otp),
    From: config.from,
    Body: `Your Nishaya Jewellery OTP is ${otp}. It is valid for ${process.env.OTP_EXPIRY_MINUTES || 5} minutes. Do not share this OTP with anyone.`,
  });
  const { response, data } = await requestJson(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok || !data?.sid || ['failed', 'undelivered', 'canceled'].includes(data?.status) || data?.error_code) {
    const rejectedCredentials = response.status === 401 || response.status === 403 || Number(data?.code) === 20003;
    // Provider messages can contain account identifiers or other request data.
    // Keep diagnostics actionable without logging or returning that raw text.
    throw providerError(rejectedCredentials ? 'OTP_PROVIDER_AUTH_FAILED' : 'OTP_DELIVERY_UNAVAILABLE', data?.code);
  }
  return { success: true, provider: 'twilio', accountSid: config.accountSid, messageSid: data.sid };
}

function getConfiguration() {
  return readConfiguration({
    accountSid: ['TWILIO_ACCOUNT_SID', 'SMS_ACCOUNT_SID'],
    authToken: ['TWILIO_AUTH_TOKEN', 'SMS_AUTH_TOKEN'],
    from: ['TWILIO_SENDER_ID', 'SMS_SENDER_ID'],
  });
}

module.exports = { sendOtp, getConfiguration };
