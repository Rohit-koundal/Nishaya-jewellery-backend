const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { accountFingerprint, safeProviderReference } = require('../otpDeliveryDiagnostics');

const MAX_BYTES = 64 * 1024;
const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, processEntities: false });
const unknown = reason => ({ deliveryStatus: 'unknown', reportAvailable: false, reason, receipts: [] });

// Delivery status is not inferred from an accepted send request or an HTTP 200.
// This is the documented transactional report API, not the SMS OTP status API.
// Some R1 accounts may not expose reports here: an unavailable report stays
// unknown and must be traced by 2Factor support, never treated as delivered.
function parseDeliveryReport(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES || /<!\s*(DOCTYPE|ENTITY)/i.test(text)) return unknown('INVALID_REPORT');
  if (XMLValidator.validate(text) !== true) return unknown('INVALID_REPORT');
  let report;
  try { report = parser.parse(text)?.smsLog; } catch { return unknown('INVALID_REPORT'); }
  if (String(report?.logStatus || '').toLowerCase() !== 'valid') return unknown('REPORT_NOT_FOUND');
  const rows = Array.isArray(report.sms) ? report.sms : report.sms ? [report.sms] : [];
  if (!rows.length || rows.length > 100) return unknown('REPORT_NOT_FOUND');
  const receipts = rows.map(row => {
    const raw = typeof row?.smsStatus?.statusDesc === 'string' ? row.smsStatus.statusDesc.trim().toUpperCase() : '';
    const status = raw === 'DELIVERED' ? 'delivered'
      : ['FAILED', 'REJECTED', 'UNDELIVERED', 'UNDELIVERABLE', 'EXPIRED', 'DELETED'].includes(raw) ? 'failed'
        : ['PENDING', 'QUEUED', 'ACCEPTED', 'ACCEPTD', 'SENT', 'SUBMITTED'].includes(raw) ? 'pending' : 'unknown';
    const number = value => /^\d{1,8}$/.test(String(value || '')) ? String(value) : null;
    return { status, statusCode: number(row?.smsStatus?.statusId), errorCode: number(row?.smsError?.errorId), errorGroup: number(row?.smsError?.errorGroupId) };
  });
  const deliveryStatus = receipts.every(row => row.status === 'delivered') ? 'delivered'
    : receipts.some(row => row.status === 'failed') ? 'failed'
      : receipts.every(row => ['pending', 'delivered'].includes(row.status)) ? 'pending' : 'unknown';
  return { deliveryStatus, reportAvailable: true, reason: null, receipts };
}

async function boundedText(response) {
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('REPORT_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('REPORT_TOO_LARGE');
    return text;
  }
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('REPORT_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

async function getDeliveryReport(reference, { expectedAccountFingerprint } = {}) {
  const apiKey = String(process.env.TWOFACTOR_API_KEY || '').trim();
  const providerReference = safeProviderReference(reference, [apiKey]);
  if (!apiKey) return unknown('API_KEY_MISSING');
  if (!providerReference) return unknown('INVALID_REFERENCE');
  const fingerprint = accountFingerprint(apiKey);
  if (expectedAccountFingerprint && expectedAccountFingerprint !== fingerprint) return unknown('ACCOUNT_MISMATCH');
  try {
    const response = await fetch(`https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/ADDON_SERVICES/RPT/TSMS/${encodeURIComponent(providerReference)}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/xml, text/xml' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ...unknown(response.status === 401 || response.status === 403 ? 'AUTH_OR_PERMISSION' : 'REPORT_UNAVAILABLE'), accountFingerprint: fingerprint };
    }
    return { ...parseDeliveryReport(await boundedText(response)), accountFingerprint: fingerprint, providerReference };
  } catch {
    // URLs contain the API key. Never print fetch errors, stacks or raw XML.
    return { ...unknown('REPORT_UNAVAILABLE'), accountFingerprint: fingerprint };
  }
}

module.exports = { getDeliveryReport, parseDeliveryReport };
