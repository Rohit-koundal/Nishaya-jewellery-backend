const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
require('./catalogTestSetup');
const { resetDatabase, startTestEnvironment, stopTestEnvironment, getBaseUrl } = require('./helpers');
const { createAdmin, createCustomer } = require('./factories');
const r2 = require('../services/r2Upload');
const { MAX_STORED_BYTES } = require('../services/imageOptimization');
test.before(startTestEnvironment); test.after(stopTestEnvironment); test.beforeEach(resetDatabase);

test('real admin/seller, draft, review, return and mixed evidence routes never persist raw image bytes', async t => {
  const admin = await createAdmin(); const customer = await createCustomer();
  // This generated single-store build intentionally has no store-provisioning
  // API. Seed membership as fixture data; exercise real seller route guards.
  const seller = await createCustomer();
  seller.store = await require('../models/Store').create({ name: 'Compressed Photos', slug: 'compressed-photos', owner: seller.user._id });
  await require('../models/StoreMember').create({ store: seller.store._id, user: seller.user._id, role: 'OWNER', status: 'ACTIVE' });
  const keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_URL'];
  const previous = keys.map(key => process.env[key]);
  keys.forEach(key => { process.env[key] = key === 'R2_PUBLIC_URL' ? 'https://media.test' : 'isolated-compression-test'; });
  t.after(() => keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }));
  const writes = []; t.mock.method(r2.getR2Client(), 'send', async command => { writes.push(command.input); return {}; });
  const original = await sharp({ create: { width: 3200, height: 2400, channels: 4, background: { r: 130, g: 30, b: 80, alpha: 0.7 } } }).png().toBuffer();
  const actors = [
    ...['products', 'categories', 'banners'].map(folder => ({ path: `/api/admin/uploads?folder=${folder}`, token: admin.token })),
    { path: '/api/seller/uploads?folder=categories', token: seller.token, store: seller.store.id },
    { path: '/api/admin/product-drafts/bulk-upload', token: admin.token, draft: true },
    { path: '/api/reviews/uploads', token: customer.token },
    { path: '/api/returns/uploads', token: customer.token },
    { path: '/api/returns/evidence/uploads', token: customer.token, field: 'files' },
    { path: '/api/admin/orders/evidence/uploads', token: admin.token, field: 'files' },
  ];
  for (const actor of actors) {
    const body = new FormData(); body.append(actor.field || 'images', new Blob([original], { type: 'image/png' }), 'original.png');
    const response = await fetch(`${getBaseUrl()}${actor.path}`, { method: 'POST', body, headers: { authorization: `Bearer ${actor.token}`, ...(actor.store ? { 'x-store-id': actor.store } : {}) } });
    const result = await response.json(); assert.equal(response.status, 201, `${actor.path}: ${JSON.stringify(result)}`);
    const sent = writes.at(-1); assert.equal(sent.ContentType, 'image/webp'); assert.ok(sent.Body.length <= MAX_STORED_BYTES);
    const metadata = await sharp(sent.Body).metadata(); assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 1600); assert.equal(metadata.height, 1200);
    const imageUrl = actor.draft ? result.data.drafts[0].image : result.files[0].url || result.files[0].fileUrl;
    assert.ok(imageUrl.endsWith(sent.Key));
    if (actor.field === 'files') { assert.equal(result.files[0].mimeType, 'image/webp'); assert.equal(result.files[0].sizeBytes, sent.Body.length); }
  }
  assert.equal(writes.length, actors.length);
  const before = writes.length; const body = new FormData(); body.append('images', new Blob(['not an image'], { type: 'image/png' }), 'fake.png');
  const invalid = await fetch(`${getBaseUrl()}/api/admin/uploads`, { method: 'POST', body, headers: { authorization: `Bearer ${admin.token}` } });
  assert.equal(invalid.status, 400); assert.equal(writes.length, before);
});
