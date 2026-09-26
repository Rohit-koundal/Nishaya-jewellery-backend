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
console.log(JSON.stringify({ ...configuration, otpMode, ready, note: 'Configuration presence only; credentials, approved template and real delivery still need a controlled live test.' }, null, 2));
if (!ready) process.exitCode = 1;
