const providers = Object.freeze({
  twilio: require('./twilioSmsProvider'),
  msg91: require('./msg91Provider'),
  '2factor': require('./twoFactorProvider'),
  fast2sms: require('./fast2smsProvider'),
});

function normalizeProvider(value) {
  const name = String(value || '').trim().toLowerCase();
  return ['twofactor', 'two-factor'].includes(name) ? '2factor' : name;
}

function getConfiguredProvider() { return normalizeProvider(process.env.SMS_PROVIDER); }
function isRealSmsProvider(name) { return Object.hasOwn(providers, normalizeProvider(name)); }
function getAdapter(name) { return isRealSmsProvider(name) ? providers[normalizeProvider(name)] : null; }

// Safe for readiness checks: return field names only, never secret values.
function getSmsConfiguration() {
  const name = getConfiguredProvider();
  const adapter = getAdapter(name);
  const missing = adapter ? adapter.getConfiguration().missing : ['SMS_PROVIDER'];
  return { provider: adapter ? name : name === 'mock' ? 'mock' : 'unconfigured', supported: Boolean(adapter), configured: Boolean(adapter) && missing.length === 0, missing };
}

module.exports = { getAdapter, getConfiguredProvider, getSmsConfiguration, isRealSmsProvider, normalizeProvider };
