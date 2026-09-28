const mockSmsProvider = require('./providers/mockSmsProvider');
const msg91Provider = require('./providers/msg91Provider');
const fast2smsProvider = require('./providers/fast2smsProvider');
const twilioSmsProvider = require('./providers/twilioSmsProvider');
const twoFactorProvider = require('./providers/twoFactorProvider');
const { isDemoOtpMode } = require('../config/env');
const { getAdapter, getConfiguredProvider, getSmsConfiguration, isRealSmsProvider } = require('./providers/smsProviderRegistry');
const { rememberDelivery } = require('./otpDeliveryDiagnostics');

function getProvider() {
  if (process.env.NODE_ENV !== 'production' && isDemoOtpMode()) return 'mock';
  return getConfiguredProvider() || 'mock';
}

async function sendOtp(phone, otp, { requireReal = false, requestId, record } = {}) {
  try {
    const provider = requireReal ? getConfiguredProvider() : getProvider();
    const adapter = getAdapter(provider);
    if (adapter) {
      const result = await adapter.sendOtp(phone, otp, { requestId });
      await rememberDelivery(record, result.delivery);
      return result;
    }
    if (provider === 'mock' && !requireReal && process.env.NODE_ENV !== 'production' && isDemoOtpMode()) return await sendViaMock(phone, otp);
    // A typo or missing live provider must never become a successful mock send.
    return { success: false, code: 'OTP_PROVIDER_NOT_CONFIGURED' };
  } catch (error) {
    const code = ['OTP_PROVIDER_AUTH_FAILED', 'OTP_PROVIDER_NOT_CONFIGURED'].includes(error.errorCode)
      ? error.errorCode : 'OTP_DELIVERY_UNAVAILABLE';
    console.warn('SMS delivery failed:', code, error.providerCode || '');
    await rememberDelivery(record, error.delivery);
    return { success: false, code, ...((record || requestId) && error.delivery ? { delivery: error.delivery } : {}) };
  }
}

async function sendViaMock(phone, otp) {
  return mockSmsProvider.sendOtp(phone, otp);
}

async function sendViaMSG91(phone, otp) {
  return msg91Provider.sendOtp(phone, otp);
}

async function sendViaFast2SMS(phone, otp) {
  return fast2smsProvider.sendOtp(phone, otp);
}

async function sendViaTwilioSMS(phone, otp) {
  return twilioSmsProvider.sendOtp(phone, otp);
}

async function sendVia2Factor(phone, otp) {
  return twoFactorProvider.sendOtp(phone, otp);
}

module.exports = {
  getProvider,
  getSmsConfiguration,
  isRealSmsProvider,
  sendOtp,
  sendViaMock,
  sendViaMSG91,
  sendViaFast2SMS,
  sendViaTwilioSMS,
  sendVia2Factor,
};
