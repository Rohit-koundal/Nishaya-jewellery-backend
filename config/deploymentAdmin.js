const { normalizePhone } = require('../utils/phoneUtils');

// Public deployment identity, never a login credential. The first configured
// admin number is the owner; the remaining numbers are ordinary admins.
const DEFAULT_OWNER_PHONE = '7988634769';
const DEFAULT_ADMIN_EMAIL = 'nishaya.in1111@gmail.com';
const LEGACY_OWNER_PHONE = '9816978086';
function configuredEntries() {
  return String(process.env.ADMIN_PHONE_NUMBERS ?? DEFAULT_OWNER_PHONE).split(',');
}
function getAdminPhones() { return [...new Set(configuredEntries().map(normalizePhone).filter(Boolean))]; }
function getOwnerPhone() { return normalizePhone(configuredEntries()[0]); }
function getAdminEmail() {
  const email = String(process.env.ADMIN_EMAIL ?? DEFAULT_ADMIN_EMAIL).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}
function isRetiredAdminPhone(phone) {
  return normalizePhone(phone) === LEGACY_OWNER_PHONE && !getAdminPhones().includes(LEGACY_OWNER_PHONE);
}
module.exports = { getAdminPhones, getOwnerPhone, getAdminEmail, isRetiredAdminPhone, LEGACY_OWNER_PHONE };
