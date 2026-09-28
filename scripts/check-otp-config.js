// Read-only readiness check. Does not send an SMS or contact any provider.
const path = require('node:path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../.env') });
dotenv.config();
const { getOtpMode } = require('../config/env');
const { getSmsConfiguration } = require('../services/smsService');
const { accountFingerprint } = require('../services/otpDeliveryDiagnostics');

const configuration = getSmsConfiguration();
const otpMode = getOtpMode();
const ready = otpMode === 'production' && configuration.configured;
console.log(JSON.stringify({
  ...configuration, otpMode, ready,
  ...(configuration.provider === '2factor'
    ? {
      accountFingerprint: accountFingerprint(process.env.TWOFACTOR_API_KEY),
      note2factor: configuration.deliveryMode === 'otp_sms'
        ? 'SMS OTP product: uses TWOFACTOR_TEMPLATE_NAME. TWOFACTOR_OTP_SMS_ONLY_CONFIRMED must be true only after 2Factor confirms voice fallback is disabled for this account; this local guard does not disable provider calls. Check SMS OTP logs, not Transactional SMS logs. See TWOFACTOR_SMS_DELIVERY.md.'
        : configuration.deliveryMode === 'transactional_sms'
          ? 'Transactional SMS product: uses sender and full message. DLT IDs are optional API overrides. DLT-CNT-REJECT requires matching approval/account mapping. See TWOFACTOR_SMS_DELIVERY.md.'
          : 'Choose TWOFACTOR_DELIVERY_MODE=transactional_sms or otp_sms (sms_otp is an alias). Unknown, voice and auto modes are blocked. See TWOFACTOR_SMS_DELIVERY.md.',
    } : {}),
  note: 'Local configuration checks only; credentials, DLT/sender approval and real SMS delivery still need a controlled live test.',
}, null, 2));
if (!ready) process.exitCode = 1;
