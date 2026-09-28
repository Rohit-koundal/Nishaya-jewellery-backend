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
    note: 'Read-only provider report; no SMS sent. Unknown/not-found does not mean failed or delivered. Confirm the same account and ask 2Factor to trace the reference if this R1 request has no report.',
  }, null, 2));
  process.exitCode = report.deliveryStatus === 'delivered' ? 0 : 2;
}

main().catch(() => { console.error('Delivery report unavailable. No SMS was sent.'); process.exitCode = 1; });
