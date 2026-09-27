const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createProduct, setSettings } = require('./factories');
const Category = require('../models/Category');
const Banner = require('../models/Banner');
const Store = require('../models/Store');
const WebsiteTheme = require('../models/WebsiteTheme');
const { ensureDefaultStore } = require('../services/storeService');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);
function ok(result) { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }

test('home remains publicly readable with no licence credentials and retains configured product order', async () => {
  await ensureDefaultStore();
  const root = await Category.create({ name: 'Earrings', slug: 'earrings', isActive: true });
  const child = await Category.create({ name: 'Jhumkas', slug: 'jhumkas', parent: root._id, level: 1, isActive: true });
  const one = await createProduct({ category: child._id, isFeatured: true, images: [{ url: '/one.jpg', primary: true }], sizes: [] });
  const two = await createProduct({ category: root._id, isFeatured: true });
  await createProduct({ isActive: false, isFeatured: true });
  await createProduct({ publishAt: new Date(Date.now() + 86400000), isFeatured: true });
  await createProduct({ isArchived: true, isFeatured: true });
  await WebsiteTheme.create({ name: 'Home', slug: 'home', isActive: true, draftConfig: {}, publishedConfig: { homepage: { sectionProductIds: { featured: [String(two._id), String(one._id)] } } } });
  await setSettings({ acceptingOrders: false, orderPauseMessage: 'Back soon' });
  const response = await request(`/api/storefront/home?recent=${one._id},${two._id}`);
  const data = ok(response);
  assert.deepEqual(data.collections.featured.map(item => String(item._id)), [String(two._id), String(one._id)]);
  assert.deepEqual(data.collections.recentlyViewed.map(item => String(item._id)), [String(one._id), String(two._id)]);
  assert.equal(data.products.length, 2);
  assert.equal(data.products.find(item => String(item._id) === String(one._id)).category.name, 'Jhumkas');
  assert.equal(data.categories.some(item => String(item._id) === String(child._id)), true);
  assert.equal(data.settings.acceptingOrders, false);
  assert.equal(data.settings.orderPauseMessage, 'Back soon');
  assert.deepEqual(data.warnings, []);
  assert.match(response.headers.get('cache-control'), /max-age=30/);
});

test('home keeps tenant boundaries, hidden ancestors and banner scheduling', async () => {
  const main = await ensureDefaultStore();
  const other = await Store.create({ name: 'Other boutique', slug: 'other-boutique', status: 'PUBLISHED' });
  const mainProduct = await createProduct({ storeId: main._id, isFeatured: true });
  const otherProduct = await createProduct({ storeId: other._id, isFeatured: true });
  const root = await Category.create({ name: 'Hidden', slug: 'hidden', storeId: other._id, isActive: false });
  const child = await Category.create({ name: 'Child', slug: 'hidden-child', storeId: other._id, parent: root._id, level: 1, isActive: true });
  await Banner.create({ title: 'Live offer', image: '/live.jpg', storeId: other._id, isActive: true });
  await Banner.create({ title: 'Future offer', image: '/future.jpg', storeId: other._id, isActive: true, startsAt: new Date(Date.now() + 86400000) });
  const data = ok(await request(`/api/storefront/home?store=other-boutique&recent=${mainProduct._id},${otherProduct._id}`));
  assert.deepEqual(data.products.map(item => String(item._id)), [String(otherProduct._id)]);
  assert.deepEqual(data.collections.recentlyViewed.map(item => String(item._id)), [String(otherProduct._id)]);
  assert.equal(data.categories.some(item => [String(root._id), String(child._id)].includes(String(item._id))), false);
  assert.deepEqual(data.banners.map(item => item.title), ['Live offer']);
});
