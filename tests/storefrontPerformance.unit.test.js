const test = require('node:test');
const assert = require('node:assert/strict');
const controlPlane = require('../services/controlPlaneClient');
const license = test.mock.method(controlPlane, 'licenseStatus', async () => { throw new Error('Licence should not be needed'); });
const licenseMiddleware = require('../middleware/externalLicenseMiddleware');
const { ApiError } = require('../utils/apiError');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Banner = require('../models/Banner');
const Settings = require('../models/Settings');
const WebsiteTheme = require('../models/WebsiteTheme');
const { getMobileHome } = require('../controllers/storefrontHomeController');

test.beforeEach(() => {
  license.mock.resetCalls();
  license.mock.mockImplementation(async () => { throw new ApiError('SERVICE_UNAVAILABLE', 'Platform unavailable'); });
});
async function gate(path, method = 'GET', user) {
  const req = { originalUrl: `/api${path}`, method, user };
  let called = false, error;
  await licenseMiddleware(req, {}, result => { called = true; error = result; });
  assert.equal(called, true);
  return { req, error };
}

test('public browsing never waits for the licence server, for guests or signed-in customers/admins', async () => {
  for (const user of [undefined, { role: 'customer' }, { role: 'admin' }]) {
    for (const path of ['/storefront/home', '/products?store=one', '/categories', '/website-config', '/settings', '/stores/resolve', '/cart']) {
      assert.equal((await gate(path, 'GET', user)).error, undefined);
      assert.equal((await gate(path, 'HEAD', user)).error, undefined);
    }
  }
  assert.equal(license.mock.callCount(), 0);
});

test('licence outages still block authenticated commerce writes', async () => {
  for (const path of ['/admin/categories', '/orders', '/payments/create-order']) {
    assert.equal((await gate(path, 'POST', { role: 'admin' })).error.errorCode, 'SERVICE_UNAVAILABLE');
  }
  assert.equal(license.mock.callCount(), 3);
});

test('expired licences still block checkout and admin writes', async () => {
  license.mock.mockImplementation(async () => ({ managed: true, status: 'EXPIRED' }));
  assert.equal((await gate('/orders/cod', 'POST', { role: 'customer' })).error.errorCode, 'SUBSCRIPTION_REQUIRED');
  assert.equal((await gate('/admin/products/item', 'PATCH', { role: 'admin' })).error.errorCode, 'SUBSCRIPTION_REQUIRED');
});

test('feature-gated reads still validate the plan and attach the verified licence', async () => {
  license.mock.mockImplementation(async () => ({ managed: true, status: 'ACTIVE', features: [], limits: {} }));
  assert.equal((await gate('/admin/reports', 'GET', { role: 'admin' })).error.errorCode, 'PLAN_FEATURE_REQUIRED');
  license.mock.mockImplementation(async () => ({ managed: true, status: 'ACTIVE', features: ['analytics'], limits: {} }));
  const result = await gate('/admin/reports', 'GET', { role: 'admin' });
  assert.equal(result.error, undefined);
  assert.equal(result.req.platformLicense.status, 'ACTIVE');
  assert.equal(license.mock.callCount(), 2);
});

test('product capacity is still enforced before admin creation', async t => {
  license.mock.mockImplementation(async () => ({ managed: true, status: 'ACTIVE', features: [], limits: { products: 10 } }));
  t.mock.method(Product, 'countDocuments', async () => 10);
  assert.equal((await gate('/admin/products', 'POST', { role: 'admin' })).error.errorCode, 'PLAN_LIMIT_REACHED');
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function query(work) {
  const chain = { select: () => chain, sort: () => chain, populate: () => chain, limit: () => chain, lean: work };
  return chain;
}
function response() {
  return { headers: {}, setHeader(key, value) { this.headers[key] = value; }, vary() {}, json(data) { this.data = data; } };
}

test('home starts products, categories, banners and settings before theme lookup completes', async t => {
  const theme = deferred(), categories = deferred(), banners = deferred(), settings = deferred(), products = deferred();
  const started = new Set(); let productCalls = 0;
  for (const [model, method, label, pending] of [
    [WebsiteTheme, 'findOne', 'theme', theme], [Category, 'find', 'categories', categories],
    [Banner, 'find', 'banners', banners], [Settings, 'findOne', 'settings', settings],
  ]) t.mock.method(model, method, () => query(() => { started.add(label); return pending.promise; }));
  t.mock.method(Product, 'find', () => query(() => { productCalls += 1; started.add('products'); return products.promise; }));
  const res = response();
  const pending = getMobileHome({ query: { recent: '0123456789abcdef01234567' }, tenantFilter: {} }, res, error => { throw error; });
  assert.deepEqual([...started].sort(), ['banners', 'categories', 'products', 'settings', 'theme']);
  assert.equal(productCalls, 9, 'Only selected/recent products depend on the theme');
  categories.resolve([]); banners.resolve([]); settings.resolve({}); products.resolve([]); theme.resolve(null);
  await pending;
  assert.equal(productCalls, 10);
  assert.deepEqual(res.data.warnings, []);
  assert.deepEqual(res.data.products, []);
  assert.match(res.headers['Cache-Control'], /^public/);
});

test('partial home failures remain isolated and are not cached as a healthy empty catalogue', async t => {
  t.mock.method(WebsiteTheme, 'findOne', () => query(async () => null));
  t.mock.method(Settings, 'findOne', () => query(async () => { throw new Error('Unavailable'); }));
  t.mock.method(Category, 'find', () => query(async () => { throw new Error('Unavailable'); }));
  t.mock.method(Banner, 'find', () => query(async () => []));
  t.mock.method(Product, 'find', () => query(async () => []));
  const res = response();
  await getMobileHome({ query: {}, tenantFilter: {} }, res, error => { throw error; });
  assert.deepEqual(res.data.warnings.sort(), ['categories', 'settings']);
  assert.equal(res.data.settings.available, false);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
