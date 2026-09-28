// Read-only readiness check. Does not send an SMS or contact any provider.
const path = require('node:path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../.env') });
dotenv.config();
const { getOtpMode } = require('../config/env');
const { getSmsConfiguration } = require('../services/smsService');

const configuration = getSmsConfiguration();
const otpMode = getOtpMode();
const ready = otpMode === 'production' && configuration.configured;
console.log(JSON.stringify({
  ...configuration, otpMode, ready,
  ...(configuration.provider === '2factor' && configuration.deliveryMode === 'otp'
    ? { warning: 'The legacy OTP route is provider-managed; its SMS label is not proof of handset delivery channel. See TWOFACTOR_SMS_DELIVERY.md for the opt-in transactional SMS route.' } : {}),
  note: 'Local configuration checks only; credentials, DLT/sender approval and real SMS delivery still need a controlled live test.',
}, null, 2));
if (!ready) process.exitCode = 1;
