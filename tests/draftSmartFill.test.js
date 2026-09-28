const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
require('./catalogTestSetup');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment, getBaseUrl } = require('./helpers');
const { createAdmin, createCustomer } = require('./factories');
const Configuration = require('../models/MasterConfiguration');
const { getIndustryPreset } = require('../config/industryPresets');
const Category = require('../models/Category');
const Product = require('../models/Product');
const ProductDraft = require('../models/ProductDraft');
const { processDraft, buildPatch } = require('../services/draftSmartFill.service');
const { readPhotoGroups } = require('../services/draftPhotoGroups');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  await Configuration.create({ _id: 'store', structure: getIndustryPreset('jewellery') });
});
const paragraph = 'These clover-shaped earrings have a gold-tone finish and a defined outline.\n\nPair the floral motif with a simple neckline to keep the shape in focus.';
function suggestion(category) { return { mode: 'ai', warnings: [], fieldSources: { 'attribute.jewellery_type': { source: 'visual', quote: 'Two earrings with clover outlines' } }, suggestion: { name: 'Gold-Tone Clover Earrings', category: String(category._id), shortDescription: 'Clover-shaped earrings with a gold-tone finish.', description: paragraph, highlights: ['Clover-shaped outline', 'Gold-tone, polished finish'], colors: ['Gold-tone'], tags: ['clover', 'earrings'], attributeValues: { jewellery_type: 'Earrings' } } }; }
async function fixture(overrides = {}) {
  const category = await Category.findOne({ slug: 'earrings' }) || await Category.create({ name: 'Earrings', slug: 'earrings', definitionKey: 'earrings' });
  const draft = await ProductDraft.create({ name: '', images: [{ url: '/uploads/clover.jpg', primary: true }], price: 0, sellingPrice: 0, originalPrice: 0, attributeValues: {}, status: 'draft', ...overrides });
  return { category, draft, req: { params: { id: String(draft._id) }, body: {}, user: { _id: new mongoose.Types.ObjectId() } } };
}

test('complete listing copy and specifications persist; refresh/replay reuse unchanged successful analysis', async () => {
  const { category, draft, req } = await fixture(); let calls = 0;
  const analyze = async () => { calls++; return suggestion(category); };
  const first = await processDraft(req, { analyze });
  assert.equal(first.draft.description, paragraph);
  assert.equal(first.draft.shortDescription, suggestion(category).suggestion.shortDescription);
  assert.deepEqual([...first.draft.highlights], ['Clover-shaped outline', 'Gold-tone, polished finish']);
  assert.deepEqual([...first.draft.tags], ['clover', 'earrings']);
  assert.equal(first.draft.attributeValues.get('jewellery_type'), 'Earrings');
  assert.match(first.draft.sku, /^NJ-/);
  assert.equal(first.draft.metaTitle, first.draft.name);
  assert.equal(first.draft.smartFill.state, 'completed');
  assert.equal(first.draft.stock, undefined); assert.equal(first.draft.attributeValues.get('metal_type'), undefined);
  assert.equal(await Product.countDocuments(), 0);
  const replay = await processDraft(req, { analyze });
  assert.equal(replay.cached, true); assert.equal(calls, 1);
  await ProductDraft.updateOne({ _id: draft._id }, { $set: { supplierNotes: 'Metal type: Brass' }, $inc: { revision: 1 } });
  await processDraft(req, { analyze }); assert.equal(calls, 2, 'changed source notes invalidate the cache');
});

test('late AI response never overwrites a concurrent manual correction', async () => {
  const { category, draft, req } = await fixture();
  const result = await processDraft(req, { analyze: async () => {
    await ProductDraft.updateOne({ _id: draft._id }, { $set: { name: 'My verified title', description: 'My edited description' }, $inc: { revision: 1 } });
    return suggestion(category);
  } });
  assert.equal(result.errorCode, 'DRAFT_STALE');
  const saved = await ProductDraft.findById(draft._id);
  assert.equal(saved.name, 'My verified title'); assert.equal(saved.description, 'My edited description');
  assert.equal(saved.smartFill.state, 'review');
});

test('per-draft lease prevents concurrent processing and an expired lease resumes', async () => {
  const { category, draft, req } = await fixture(); let release; let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const first = processDraft(req, { analyze: async () => { entered(); await new Promise(resolve => { release = resolve; }); return suggestion(category); } });
  await waiting;
  await assert.rejects(processDraft(req, { analyze: async () => suggestion(category) }), error => error.errorCode === 'DUPLICATE_REQUEST');
  release(); await first;
  await ProductDraft.updateOne({ _id: draft._id }, { $set: { 'smartFill.state': 'running', 'smartFill.startedAt': new Date(Date.now() - 100000) } });
  assert.equal((await processDraft(req, { analyze: async () => suggestion(category) })).draft.smartFill.state, 'completed');
});

test('quota failures and ambiguous photo groups persist actionable status without applying fallback', async () => {
  const { draft, req, category } = await fixture();
  const result = await processDraft(req, { analyze: async () => ({ mode: 'notes', errorCode: 'AI_QUOTA_EXCEEDED', warnings: ['AI quota exhausted'], suggestion: { name: 'Do not save fallback' } }) });
  assert.equal(result.errorCode, 'AI_QUOTA_EXCEEDED'); assert.equal(result.draft.name, '');
  assert.equal((await ProductDraft.findById(draft._id)).smartFill.state, 'failed');
  const review = await processDraft(req, { analyze: async () => ({ ...suggestion(category), requiresReview: true, warnings: ['More than one product is present'] }) });
  assert.equal(review.draft.smartFill.state, 'review'); assert.equal(review.draft.name, '');
});

test('refreshing just description protects all manually set fields and other copy', async () => {
  const { draft, req, category } = await fixture({ name: 'Manual title', description: 'Old copy', shortDescription: 'Manual summary', sellingPrice: 300, price: 300, originalPrice: 500, stock: 4, attributeValues: { metal_type: 'Brass' } });
  req.body.refreshFields = ['description'];
  const result = await processDraft(req, { analyze: async () => suggestion(category) });
  assert.equal(result.draft.description, paragraph); assert.equal(result.draft.name, draft.name);
  assert.equal(result.draft.shortDescription, 'Manual summary'); assert.equal(result.draft.stock, 4);
  assert.equal(result.draft.attributeValues.get('metal_type'), 'Brass'); assert.equal(result.draft.sellingPrice, 300);
  req.body.refreshFields = ['stock'];
  await assert.rejects(processDraft(req), error => error.errorCode === 'VALIDATION_ERROR');
});

test('server rejects stale source/provenance writes and permissions; draft status is server owned', async () => {
  const { draft } = await fixture(); const admin = await createAdmin(); const customer = await createCustomer();
  const denied = await request(`/api/admin/product-drafts/${draft._id}/smart-fill`, { method: 'POST', token: customer.token, body: {} });
  assert.equal(denied.status, 403);
  const saved = await request(`/api/admin/product-drafts/${draft._id}`, { method: 'PUT', token: admin.token, body: { name: 'Owner title', baseRevision: 0, smartFill: { state: 'completed', fingerprint: 'fake' } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal((await ProductDraft.findById(draft._id)).smartFill, undefined);
  const foreign = { params: { id: String(draft._id) }, body: {}, tenantFilter: { storeId: new mongoose.Types.ObjectId() }, user: { _id: admin.user?._id } };
  await assert.rejects(processDraft(foreign), error => error.errorCode === 'NOT_FOUND');
});

test('required specs report incomplete and invalid item cannot block valid batch publication; copy survives publishing', async () => {
  const { category, draft, req } = await fixture({ sellingPrice: 299, price: 299, originalPrice: 599, stock: 3, attributeValues: { metal_type: 'Brass', weight: '5' } });
  const filled = await processDraft(req, { analyze: async () => suggestion(category) });
  const incomplete = await ProductDraft.create({ ...filled.draft.toObject(), _id: new mongoose.Types.ObjectId(), sku: 'INCOMPLETE', attributeValues: {}, smartFill: undefined });
  const admin = await createAdmin();
  const detail = await request(`/api/admin/product-drafts/${incomplete._id}`, { token: admin.token });
  assert.equal(detail.data.data.readiness.state, 'incomplete');
  assert.ok(detail.data.data.readiness.issues.some(message => /Jewellery type|Metal type|weight/i.test(message)));
  const response = await request('/api/admin/product-drafts/publish-selected', { method: 'POST', token: admin.token, body: { ids: [String(incomplete._id), String(draft._id)] } });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.deepEqual(response.data.data.results.map(item => item.status), ['failed', 'published']);
  const product = await Product.findOne({ sourceDraftId: draft._id });
  assert.equal(product.description, paragraph); assert.equal(product.metaTitle, filled.draft.metaTitle);
  assert.deepEqual([...product.highlights], [...filled.draft.highlights]);
  assert.equal(product.attributeValues.get('metal_type'), 'Brass');
  await request('/api/admin/product-drafts/publish-selected', { method: 'POST', token: admin.token, body: { ids: [String(draft._id)] } });
  assert.equal(await Product.countDocuments({ sourceDraftId: draft._id }), 1);
});

test('photo groups preserve explicit order/cover and reject duplicates, omissions or over-sized products', () => {
  assert.deepEqual(readPhotoGroups(JSON.stringify([{ fileIndexes: [2, 0], reference: 'E100' }, { fileIndexes: [1] }]), 3), [{ fileIndexes: [2, 0], reference: 'E100' }, { fileIndexes: [1] }]);
  for (const groups of [[{ fileIndexes: [0, 0] }], [{ fileIndexes: [1] }], [{ fileIndexes: [0, 1, 4] }], [{ fileIndexes: Array.from({ length: 13 }, (_, i) => i) }]]) assert.throws(() => readPhotoGroups(groups, 3));
});

test('blank draft stock remains unknown through saves and blocks publication instead of becoming zero', async () => {
  const { category, draft } = await fixture({ name: 'Verified earrings', sellingPrice: 299, price: 299, originalPrice: 599, stock: 3,
    attributeValues: { jewellery_type: 'Earrings', metal_type: 'Brass', weight: '5' } });
  draft.category = category._id; await draft.save();
  const { token } = await createAdmin();
  const saved = await request(`/api/admin/product-drafts/${draft._id}`, { method: 'PUT', token, body: { stock: '', baseRevision: 0 } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.data.stock, null);
  assert.ok(saved.data.data.readiness.issues.some(message => /stock quantity/i.test(message)));
  const publish = await request('/api/admin/product-drafts/publish-selected', { method: 'POST', token, body: { ids: [String(draft._id)] } });
  assert.equal(publish.data.data.results[0].status, 'failed');
  assert.equal(await Product.countDocuments({ sourceDraftId: draft._id }), 0);
});

test('price evidence, variants and explicit facts remain protected in batch mapping', () => {
  const result = { suggestion: { name: 'AI', price: 1000, originalPrice: 900, stock: 999, colors: ['Gold'], sizes: ['M'] }, fieldSources: { price: { source: 'caption' }, originalPrice: { source: 'caption' } } };
  const patch = buildPatch(result, { name: 'Manual', variants: [{ color: 'Silver', stock: 3 }], sellingPrice: 0, originalPrice: 0 });
  assert.equal(patch.name, undefined); assert.equal(patch.stock, undefined); assert.equal(patch.colors, undefined); assert.equal(patch.sellingPrice, undefined);
});

test('multipart grouping → shared single/bulk AI → persisted details → manual review uses real protected routes', async (t) => {
  const fs = require('node:fs/promises'); const path = require('node:path');
  const { token } = await createAdmin();
  const category = await Category.create({ name: 'Earrings', slug: 'api-earrings', definitionKey: 'earrings' });
  const form = new FormData();
  // Identically named views from separate folders must have distinct storage paths.
  for (let i = 0; i < 3; i++) form.append('images', new Blob([new Uint8Array([255, 216, 255, i + 1])], { type: 'image/jpeg' }), 'front.jpg');
  form.append('groups', JSON.stringify([{ fileIndexes: [1, 0], reference: 'REF-A' }, { fileIndexes: [2], reference: 'REF-B' }]));
  const upload = await fetch(`${getBaseUrl()}/api/admin/product-drafts/bulk-upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const uploaded = await upload.json(); assert.equal(upload.status, 201, JSON.stringify(uploaded));
  const drafts = uploaded.data.drafts;
  const urls = drafts.flatMap(draft => draft.images.map(image => image.url));
  t.after(async () => {
    const root = path.resolve(__dirname, '../uploads');
    for (const url of urls) {
      const filename = path.basename(new URL(url, getBaseUrl()).pathname);
      const target = path.resolve(root, filename);
      if (path.dirname(target) === root) await fs.unlink(target).catch(() => {});
    }
  });
  assert.equal(new Set(urls).size, 3); assert.equal(drafts[0].images.length, 2);
  assert.equal(drafts[0].images[0].primary, true); assert.equal(drafts[0].supplierSku, 'REF-A');
  assert.equal(drafts[0].stock, undefined);
  const previous = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'mock-fixture-key';
  t.after(() => { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous; });
  const originalFetch = global.fetch;
  let aiCalls = 0;
  t.mock.method(global, 'fetch', async (url, options) => {
    if (!String(url).startsWith('https://generativelanguage.googleapis.com/')) return originalFetch(url, options);
    aiCalls++;
    const parts = JSON.parse(options.body).contents[0].parts;
    assert.equal(parts.filter(part => part.inlineData).length, 2);
    const raw = { ...suggestion(category).suggestion, multipleProducts: false, priceAmbiguous: false, currency: 'INR', price: 299, originalPrice: 599,
      attributeValues: { jewellery_type: 'Earrings', metal_type: 'Brass', weight: '5' }, fieldSources: { ...suggestion(category).fieldSources,
        price: { source: 'caption', quote: 'Selling price: 299' }, originalPrice: { source: 'caption', quote: 'MRP: 599' },
        'attribute.metal_type': { source: 'caption', quote: 'Metal type: Brass' }, 'attribute.weight': { source: 'caption', quote: 'Weight: 5' } } };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(raw) }] } }] }) };
  });
  const notes = 'Metal type: Brass\nWeight: 5\nBrand: Nishaya Jewellery\nCare instructions: Keep dry.\nSelling price: 299\nMRP: 599';
  const single = await request('/api/admin/products/smart-fill', { method: 'POST', token, body: { notes, imageUrls: drafts[0].images.map(image => image.url) } });
  assert.equal(single.status, 200, JSON.stringify(single.data));
  const bulk = await request(`/api/admin/product-drafts/${drafts[0]._id}/smart-fill`, { method: 'POST', token, body: { notes, baseRevision: 0 } });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.data)); assert.equal(bulk.data.success, true, JSON.stringify(bulk.data));
  for (const key of ['name', 'description', 'shortDescription', 'highlights', 'tags', 'colors', 'brand', 'careInstructions', 'attributeValues']) assert.deepEqual(bulk.data.data[key], single.data.suggestion[key], key);
  assert.equal(aiCalls, 2);
  const replay = await request(`/api/admin/product-drafts/${drafts[0]._id}/smart-fill`, { method: 'POST', token, body: { notes, baseRevision: bulk.data.data.revision } });
  assert.equal(replay.data.cached, true); assert.equal(aiCalls, 2);
  const confirmed = await request(`/api/admin/product-drafts/${drafts[0]._id}`, { method: 'PUT', token, body: { stock: 2, baseRevision: bulk.data.data.revision, confirmSmartFillReview: true } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data)); assert.equal(confirmed.data.data.smartFill.state, 'reviewed');
});
