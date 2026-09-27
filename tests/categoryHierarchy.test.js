require('./catalogTestSetup');
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, createCoupon, setSettings } = require('./factories');
const Category = require('../models/Category');
const Product = require('../models/Product');
const ProductDraft = require('../models/ProductDraft');
const Coupon = require('../models/Coupon');
const { validateCoupon, calculateDiscount } = require('../services/couponService');
const { readCategoryHierarchy, resolveCategoryIds, visibleCategories } = require('../services/categoryHierarchy');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

async function branch() {
  const root = await Category.create({ name: 'Earrings', slug: 'earrings' });
  const child = await Category.create({ name: 'Jhumkas', slug: 'jhumkas', parent: root._id, level: 1 });
  const leaf = await Category.create({ name: 'Silver Jhumkas', slug: 'silver-jhumkas', parent: child._id, level: 2 });
  return { root, child, leaf };
}
const ids = (response) => response.data.items.map((item) => item._id).sort();

test('parent pages, slug links, multi-select and paginated facets include descendants once', async () => {
  const { root, child, leaf } = await branch();
  const direct = await createProduct({ category: root._id });
  const nested = await createProduct({ category: leaf._id });
  await createProduct();
  for (const selected of [root._id, 'earrings', `${root._id},${child._id}`]) {
    const response = await request(`/api/products?category=${selected}&page=1&includeFacets=true`);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.deepEqual(ids(response), [String(direct._id), String(nested._id)].sort());
    assert.equal(response.data.facets.categories.find((item) => item.value === String(root._id)).count, 2);
    assert.equal(response.data.facets.categories.find((item) => item.value === String(child._id)).count, 1);
    assert.equal(response.data.facets.prices.reduce((sum, item) => sum + item.count, 0), 2);
  }
  assert.deepEqual(ids(await request(`/api/products?category=${child._id}&page=1`)), [String(nested._id)]);
  assert.deepEqual(ids(await request('/api/products?category=unknown-category&page=1')), []);
});

test('search by parent category finds nested products and matching facet counts', async () => {
  const { root, leaf } = await branch();
  const product = await createProduct({ name: 'Oxidised festive pair', category: leaf._id });
  const response = await request('/api/products?search=earrings&page=1&includeFacets=true');
  assert.deepEqual(ids(response), [String(product._id)]);
  assert.equal(response.data.facets.categories.find((item) => item.value === String(root._id)).count, 1);
});

test('renaming a category preserves historical links and product references', async () => {
  const { token } = await createAdmin();
  const { root, leaf } = await branch();
  const product = await createProduct({ category: leaf._id, subCategory: 'Legacy handmade style' });
  const changed = await request(`/api/admin/categories/${root._id}`, { method: 'PUT', token, body: { slug: 'statement-earrings' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.deepEqual(ids(await request('/api/products?category=earrings&page=1')), [String(product._id)]);
  assert.equal((await Product.findById(product._id)).subCategory, 'Legacy handmade style');
});

test('category edit hides the entire branch and public reads suppress stale active children', async () => {
  const { token } = await createAdmin();
  const { root, child, leaf } = await branch();
  const changed = await request(`/api/admin/categories/${root._id}`, { method: 'PUT', token, body: { isActive: false } });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal((await Category.findById(leaf._id)).isActive, false);
  await Category.updateMany({ _id: { $in: [child._id, leaf._id] } }, { $set: { isActive: true } });
  const publicList = await request('/api/categories');
  assert.equal(publicList.status, 200);
  assert.ok(!publicList.data.some((item) => [root, child, leaf].some((node) => String(node._id) === item._id)));
  const show = await request(`/api/admin/categories/${leaf._id}/status`, { method: 'PATCH', token, body: { isActive: true } });
  assert.equal(show.status, 400);
});

test('cycle, self-parent and excessive hierarchy depth are rejected', async () => {
  const { token } = await createAdmin();
  const { root, leaf } = await branch();
  for (const parent of [root._id, leaf._id]) {
    assert.equal((await request(`/api/admin/categories/${root._id}`, { method: 'PUT', token, body: { parent } })).status, 400);
  }
  let parent = leaf;
  for (let level = 3; level <= 5; level += 1) parent = await Category.create({ name: `Level ${level}`, slug: `level-${level}`, parent: parent._id, level });
  const response = await request('/api/admin/categories', { method: 'POST', token, body: { name: 'Too deep', parent: parent._id } });
  assert.equal(response.status, 400);
});

test('moving a branch updates descendant levels and category listing returns full paths/counts', async () => {
  const { token } = await createAdmin();
  const { root, child, leaf } = await branch();
  await createProduct({ category: leaf._id });
  const response = await request(`/api/admin/categories/${child._id}`, { method: 'PUT', token, body: { parent: null } });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal((await Category.findById(leaf._id)).level, 1);
  const listing = await request('/api/admin/categories', { token });
  const branchRow = listing.data.find((item) => item._id === String(child._id));
  assert.equal(branchRow.productCount, 1);
  assert.equal(listing.data.find((item) => item._id === String(root._id)).productCount, 0);
  assert.deepEqual(listing.data.find((item) => item._id === String(leaf._id)).path.map((item) => item.name), ['Jhumkas', 'Silver Jhumkas']);
});

test('branch reassignment moves products, drafts and coupons and rejects its own descendants', async () => {
  const { token } = await createAdmin();
  const { root, leaf } = await branch();
  const destination = await Category.create({ name: 'Accessories', slug: 'accessories' });
  const product = await createProduct({ category: leaf._id });
  const draft = await ProductDraft.create({ name: 'Draft pair', category: leaf._id });
  const coupon = await createCoupon({ applicableCategories: [leaf._id, root._id] });
  const invalid = await request(`/api/admin/categories/${root._id}/reassign`, { method: 'POST', token, body: { targetCategoryId: leaf._id } });
  assert.equal(invalid.status, 400);
  const impact = await request(`/api/admin/categories/${root._id}/impact`, { token });
  assert.equal(impact.data.productCount, 1);
  assert.equal(impact.data.draftCount, 1);
  const moved = await request(`/api/admin/categories/${root._id}/reassign`, { method: 'POST', token, body: { targetCategoryId: destination._id } });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(String((await Product.findById(product._id)).category), String(destination._id));
  assert.equal(String((await ProductDraft.findById(draft._id)).category), String(destination._id));
  assert.deepEqual((await Coupon.findById(coupon._id)).applicableCategories.map(String), [String(destination._id)]);
  assert.equal((await Category.findById(leaf._id)).isArchived, true);
});

test('parent-category coupon applies only to its descendants and retains stored scope', async () => {
  const { root, leaf } = await branch();
  const coupon = await createCoupon({ applicableCategories: [root._id], type: 'Percentage', discountValue: 10 });
  const items = [{ category: leaf._id, price: 1000, quantity: 1 }, { category: new mongoose.Types.ObjectId(), price: 500, quantity: 1 }];
  const validated = await validateCoupon({ code: coupon.code, cartTotal: 1500, items });
  assert.equal(calculateDiscount(validated, 1500, items), 100);
  assert.deepEqual((await Coupon.findById(coupon._id)).applicableCategories.map(String), [String(root._id)]);
});

test('store-scoped hierarchy never expands into another store', async () => {
  const storeA = new mongoose.Types.ObjectId(); const storeB = new mongoose.Types.ObjectId();
  const root = await Category.create({ name: 'Rings', slug: 'rings', storeId: storeA });
  const foreign = await Category.create({ name: 'Foreign ring', slug: 'foreign-ring', parent: root._id, storeId: storeB });
  const tree = await readCategoryHierarchy({ storeId: storeA });
  assert.deepEqual(resolveCategoryIds(tree, ['rings']), [String(root._id)]);
  assert.ok(!resolveCategoryIds(tree, [String(foreign._id)]).length);
});

test('customers cannot create categories and linked branches cannot be deleted', async () => {
  const { token: customerToken } = await createCustomer();
  assert.equal((await request('/api/admin/categories', { method: 'POST', token: customerToken, body: { name: 'Not allowed' } })).status, 403);
  const { token } = await createAdmin();
  const { root } = await branch();
  await request(`/api/admin/categories/${root._id}/archive`, { method: 'PATCH', token, body: {} });
  const deleted = await request(`/api/admin/categories/${root._id}?confirm=Earrings`, { method: 'DELETE', token });
  assert.equal(deleted.status, 409, JSON.stringify(deleted.data));
  assert.ok(await Category.findById(root._id));
});

test('visibility traversal is cycle-safe and suppresses orphan branches', () => {
  assert.deepEqual(visibleCategories([{ _id: 'a', parent: 'b', isActive: true }, { _id: 'b', parent: 'a', isActive: true }, { _id: 'orphan', parent: 'missing', isActive: true }]), []);
});

test('admin creates and edits a nested product with required jewellery attributes and public breadcrumbs', async () => {
  const { token } = await createAdmin();
  const { root, leaf } = await branch();
  const created = await request('/api/admin/products', { method: 'POST', token, body: {
    name: 'Silver festive pair', sku: 'SILVER-PAIR-TEST', category: String(leaf._id), subCategory: 'Handcrafted', price: 1499, originalPrice: 1799, stock: 5,
    images: [{ url: '/uploads/test.jpg', primary: true }], attributeValues: { jewellery_type: 'Earrings', metal_type: 'Silver', weight: '10' },
  } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const detail = await request(`/api/products/${created.data._id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.data.categoryPath.map((item) => item.name), ['Earrings', 'Jhumkas', 'Silver Jhumkas']);
  const updated = await request(`/api/admin/products/${created.data._id}`, { method: 'PUT', token, body: { category: String(root._id) } });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal((await Product.findById(created.data._id)).subCategory, 'Handcrafted');
});

test('new child slugs are parent-qualified and duplicate names are allowed only under different parents', async () => {
  const { token } = await createAdmin();
  const { root } = await branch();
  const other = await Category.create({ name: 'Rings', slug: 'rings' });
  for (const parent of [root, other]) {
    const result = await request('/api/admin/categories', { method: 'POST', token, body: { name: 'Silver', parent: String(parent._id) } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.slug, `${parent.slug}-silver`);
  }
  const duplicate = await request('/api/admin/categories', { method: 'POST', token, body: { name: 'Silver', slug: 'another-url', parent: String(root._id) } });
  assert.equal(duplicate.status, 409);
});

test('parent draft filters find nested drafts without changing their saved category', async () => {
  const { token } = await createAdmin();
  const { root, leaf } = await branch();
  const draft = await ProductDraft.create({ name: 'Silver pair draft', category: leaf._id });
  const response = await request(`/api/admin/product-drafts?category=${root._id}`, { token });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.ok(response.data.data.some((item) => item._id === String(draft._id)));
  assert.equal(String((await ProductDraft.findById(draft._id)).category), String(leaf._id));
});

test('checkout quote evaluates the same parent-category coupon scope as preview', async () => {
  const { token } = await createCustomer();
  const { root, leaf } = await branch();
  const product = await createProduct({ category: leaf._id, price: 1000, originalPrice: 1000, sizes: [], sizingMode: 'free-size' });
  const coupon = await createCoupon({ applicableCategories: [root._id], type: 'Percentage', discountValue: 10 });
  await setSettings({ deliveryCharge: 0, freeShippingMinAmount: 0 });
  const quote = await request('/api/orders/quote', { method: 'POST', token, body: { orderItems: [{ product: String(product._id), quantity: 1 }], couponCode: coupon.code, paymentMethod: 'COD' } });
  assert.equal(quote.status, 200, JSON.stringify(quote.data));
  assert.equal(quote.data.totals.finalAmount, 900);
});

test('custom nested categories inherit the nearest mapped parent product template', async () => {
  const Configuration = require('../models/MasterConfiguration');
  const { DEFAULT_STRUCTURE } = require('../config/industryPresets');
  const { applyProductStructure } = require('../services/masterConfigurationService');
  const { leaf } = await branch();
  await Configuration.create({ _id: 'store', structure: { ...JSON.parse(JSON.stringify(DEFAULT_STRUCTURE)), categoryDefinitions: [{ key: 'earrings', name: 'Earrings', attributes: [{ key: 'fastening', label: 'Fastening', type: 'text', required: true }] }] } });
  const payload = { category: leaf._id, attributeValues: { jewellery_type: 'Earrings', metal_type: 'Silver', weight: 10 } };
  await assert.rejects(applyProductStructure(payload), /Fastening/);
  const resolved = await applyProductStructure({ ...payload, attributeValues: { ...payload.attributeValues, fastening: 'Hook' } });
  assert.equal(resolved.categoryDefinitionKey, 'earrings');
});

test('branch reassignment rolls back product moves if another write fails on a replica set', async (t) => {
  const { token } = await createAdmin();
  const { root, leaf } = await branch();
  const target = await Category.create({ name: 'Other jewellery', slug: 'other-jewellery' });
  const product = await createProduct({ category: leaf._id });
  t.mock.method(ProductDraft, 'updateMany', async () => { throw new Error('Injected draft write failure'); });
  const response = await request(`/api/admin/categories/${root._id}/reassign`, { method: 'POST', token, body: { targetCategoryId: target._id } });
  assert.equal(response.status, 500);
  assert.equal(String((await Product.findById(product._id)).category), String(leaf._id));
  assert.equal((await Category.findById(root._id)).isArchived, false);
});
