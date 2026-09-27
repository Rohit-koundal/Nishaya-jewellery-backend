// Explicit opt-in for local catalog/commerce tests in generated managed builds.
// This file is never imported by the application. The shared harness removes
// production credentials and only connects to a dedicated test database.
require('./helpers');
if (process.env.NODE_ENV !== 'test') throw new Error('Catalog test setup requires test mode');
require('../services/controlPlaneClient').licenseStatus = async () => ({ managed: false, source: 'test-fixture', status: 'ACTIVE' });
