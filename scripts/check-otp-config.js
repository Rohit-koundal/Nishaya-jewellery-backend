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
      note2factor: 'Transactional SMS only. Compare this fingerprint with live otp.delivery logs to detect a different account. Readiness does not check sender/DLT approval. See TWOFACTOR_SMS_DELIVERY.md.',
    } : {}),
  note: 'Local configuration checks only; credentials, DLT/sender approval and real SMS delivery still need a controlled live test.',
}, null, 2));
if (!ready) process.exitCode = 1;
