const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { optimizeImageBuffer, MAX_STORED_BYTES } = require('../services/imageOptimization');
const r2 = require('../services/r2Upload');

async function photo() {
  return sharp({ create: { width: 3200, height: 2400, channels: 4, background: { r: 185, g: 45, b: 90, alpha: 0.5 } } }).png().toBuffer();
}

test('optimizer preserves aspect ratio/transparency, bounds bytes/dimensions and does not re-encode small WebP', async () => {
  const optimized = await optimizeImageBuffer(await photo());
  const metadata = await sharp(optimized.buffer).metadata();
  assert.equal(metadata.format, 'webp'); assert.equal(metadata.hasAlpha, true);
  assert.equal(metadata.width, 1600); assert.equal(metadata.height, 1200);
  assert.ok(optimized.sizeBytes <= MAX_STORED_BYTES);
  const second = await optimizeImageBuffer(optimized.buffer);
  assert.deepEqual(second.buffer, optimized.buffer, 'already optimized bytes must not incur another lossy encode');
  const tiny = await optimizeImageBuffer(await sharp({ create: { width: 12, height: 8, channels: 3, background: '#fff' } }).png().toBuffer());
  assert.equal(tiny.width, 12); assert.equal(tiny.height, 8);
});

test('optimizer corrects EXIF orientation and strips metadata without forcing social JPEG into WebP', async () => {
  const source = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#cc3355' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const result = await optimizeImageBuffer(source, { format: 'jpeg' });
  const metadata = await sharp(result.buffer).metadata();
  assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.width, 100); assert.equal(metadata.height, 200);
  assert.equal(metadata.orientation, undefined); assert.equal(metadata.exif, undefined);
});

test('invalid, unsupported and oversized images fail closed', async () => {
  for (const source of [Buffer.from('fake webp'), Buffer.alloc(0), Buffer.alloc(21 * 1024 * 1024), Buffer.from('<svg width="2" height="2"></svg>')]) {
    await assert.rejects(optimizeImageBuffer(source), error => error.errorCode === 'IMAGE_OPTIMIZATION_FAILED');
  }
});

test('a genuinely multi-megabyte detailed original is compressed below the cloud ceiling', async () => {
  const raw = require('node:crypto').randomBytes(2400 * 1600 * 3);
  const original = await sharp(raw, { raw: { width: 2400, height: 1600, channels: 3 } }).png().toBuffer();
  assert.ok(original.length > 5 * 1024 * 1024);
  const result = await optimizeImageBuffer(original);
  assert.ok(result.sizeBytes <= MAX_STORED_BYTES);
  assert.ok(result.width >= 1280 && result.width <= 1600);
  assert.ok(Math.abs(result.width / result.height - 1.5) < 0.01);
});

test('all R2 image folders and the generic mixed-file path store real optimized WebP with accurate metadata', async t => {
  const keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_URL'];
  const previous = keys.map(key => process.env[key]);
  keys.forEach(key => { process.env[key] = key === 'R2_PUBLIC_URL' ? 'https://media.test' : 'isolated-image-test'; });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nishaya-optimize-'));
  const source = path.join(directory, 'original.png'); await fs.writeFile(source, await photo());
  t.after(async () => { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); await fs.unlink(source); await fs.rmdir(directory); });
  const writes = []; t.mock.method(r2.getR2Client(), 'send', async command => { writes.push(command.input); return {}; });
  const file = { path: source, originalname: 'original.png', mimetype: 'image/png', size: (await fs.stat(source)).size };
  for (const folder of ['products', 'categories', 'banners', 'website-branding', 'reviews', 'returns', 'verification', 'reel-imports/candidates']) {
    const saved = await r2.uploadFileToR2(file, { folder });
    const sent = writes.at(-1);
    assert.match(sent.Key, /\.webp$/); assert.ok(sent.Key.startsWith(folder + '/'));
    assert.equal(sent.ContentType, 'image/webp'); assert.ok(sent.Body.length <= MAX_STORED_BYTES);
    assert.equal((await sharp(sent.Body).metadata()).format, 'webp');
    assert.equal(saved.sizeBytes, sent.Body.length); assert.equal(saved.mimeType, sent.ContentType);
  }
  const videoBytes = Buffer.from('small-video-fixture'); await fs.writeFile(source, videoBytes);
  const videoSend = t.mock.method(r2.getR2Client(), 'send', async command => {
    assert.equal(command.input.ContentType, 'video/mp4');
    const chunks = []; for await (const chunk of command.input.Body) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), videoBytes); return {};
  });
  const video = await r2.uploadFileToR2({ path: source, originalname: 'proof.mp4', mimetype: 'video/mp4', size: videoBytes.length });
  assert.match(video.url, /\.mp4$/);
  const before = videoSend.mock.callCount(); await fs.writeFile(source, 'corrupt');
  await assert.rejects(r2.uploadImageToR2(file)); assert.equal(videoSend.mock.callCount(), before);
});

test('Cloudinary fallback and social buffer writes obey the same storage ceiling', async t => {
  const cloud = require('../services/cloudinaryUpload'); const storage = require('../services/mediaStorage.service');
  const keys = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']; const previous = keys.map(key => process.env[key]);
  keys.forEach(key => { process.env[key] = 'isolated-image-test'; });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nishaya-cloud-image-'));
  const source = path.join(directory, 'original.png'); const bytes = await photo(); await fs.writeFile(source, bytes);
  t.after(async () => { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); await fs.unlink(source); await fs.rmdir(directory); });
  t.mock.method(global, 'fetch', async (_url, options) => {
    const sent = options.body.get('file'); assert.equal(sent.type, 'image/webp'); assert.ok(sent.size <= MAX_STORED_BYTES);
    assert.equal((await sharp(Buffer.from(await sent.arrayBuffer())).metadata()).format, 'webp');
    return { ok: true, json: async () => ({ secure_url: 'https://media.test/a.webp', public_id: 'a' }) };
  });
  const result = await cloud.uploadImage({ path: source, originalname: 'a.png', mimetype: 'image/png' });
  assert.equal(result.mimeType, 'image/webp'); assert.ok(result.sizeBytes <= MAX_STORED_BYTES);
  const writes = []; t.mock.method(r2.getR2Client(), 'send', async command => { writes.push(command.input); return {}; });
  await storage.putBufferToR2(bytes, 'social-studio/post.jpg', 'image/jpeg');
  assert.equal(writes[0].ContentType, 'image/jpeg'); assert.ok(writes[0].Body.length <= MAX_STORED_BYTES);
  assert.equal((await sharp(writes[0].Body).metadata()).format, 'jpeg');
});
