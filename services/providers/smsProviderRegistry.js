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
  const configuration = adapter?.getConfiguration();
  const missing = configuration?.missing || ['SMS_PROVIDER'];
  const invalid = configuration?.invalid || [];
  return {
    provider: adapter ? name : name === 'mock' ? 'mock' : 'unconfigured',
    supported: Boolean(adapter), configured: Boolean(adapter) && missing.length === 0 && invalid.length === 0, missing,
    ...(configuration?.deliveryMode ? { deliveryMode: configuration.deliveryMode, invalid } : {}),
    ...(configuration?.supportedDeliveryModes ? { supportedDeliveryModes: configuration.supportedDeliveryModes } : {}),
  };
}

module.exports = { getAdapter, getConfiguredProvider, getSmsConfiguration, isRealSmsProvider, normalizeProvider };
