// Read-only. Does not send/retry SMS, change OTPs, or connect to the database.
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { getDeliveryReport } = require('../services/providers/twoFactorDeliveryReport');

async function main() {
  const [reference, accountOption, ...extra] = process.argv.slice(2);
  if (!reference || extra.length || (accountOption && !/^--account=[a-f0-9]{16}$/.test(accountOption))) {
    console.error('Usage: npm run check:otp-delivery -- <providerReference from otp.delivery log> [--account=<accountFingerprint>]');
    process.exitCode = 1;
    return;
  }
  const report = await getDeliveryReport(reference, { expectedAccountFingerprint: accountOption?.slice('--account='.length) });
  console.log(JSON.stringify({
    ...report,
    note: 'Read-only transactional report; no SMS sent. REPORT_MODE_UNSUPPORTED: use SMS OTP dashboard logs for otp_sms, not this transactional endpoint. Unknown/not-found does not mean failed or delivered. Match the sending account, mode and reference.',
  }, null, 2));
  process.exitCode = report.deliveryStatus === 'delivered' ? 0 : 2;
}

main().catch(() => { console.error('Delivery report unavailable. No SMS was sent.'); process.exitCode = 1; });
