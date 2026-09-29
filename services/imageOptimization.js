const fs = require('node:fs/promises');
const sharp = require('sharp');
const { ApiError } = require('../utils/apiError');

// Browser uploads use the same 1600px / 0.7MiB ceiling. Cloud persistence is
// authoritative: imports, evidence and direct callers cannot bypass this guard.
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_STORED_BYTES = Math.floor(0.7 * 1024 * 1024);
const MAX_DIMENSION = 1600;
const decoder = { failOn: 'warning', limitInputPixels: 60000000 };
sharp.cache({ memory: 16, files: 0, items: 20 });
sharp.concurrency(1);
let tail = Promise.resolve();
let queued = 0;

function imageError(message) { return new ApiError('IMAGE_OPTIMIZATION_FAILED', message, { statusCode: 400 }); }
function schedule(work) {
  if (queued >= 40) return Promise.reject(new ApiError('SERVICE_UNAVAILABLE', 'Image processing is busy. Please retry shortly. No original was stored.'));
  queued++;
  const task = tail.then(work);
  tail = task.catch(() => {});
  return task.finally(() => { queued--; });
}

async function encode(buffer, { format = 'webp' } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_SOURCE_BYTES) throw imageError('Choose a valid photo up to 20MB before compression.');
  if (!['webp', 'jpeg'].includes(format)) throw imageError('Unsupported stored image format.');
  try {
    const metadata = await sharp(buffer, decoder).metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1) throw imageError('Use a still JPG, PNG or WEBP photo. Animated or unsupported images cannot be stored.');
    // Avoid cumulative lossy encoding of already-optimized browser photos.
    // Decode once to reject corrupt/truncated files, not just a matching header.
    if (metadata.format === format && buffer.length <= MAX_STORED_BYTES
      && metadata.width <= MAX_DIMENSION && metadata.height <= MAX_DIMENSION
      && !metadata.orientation && !metadata.exif && !metadata.icc && !metadata.xmp) {
      await sharp(buffer, decoder).raw().toBuffer();
      return { buffer, mimeType: `image/${format}`, extension: format === 'jpeg' ? 'jpg' : 'webp', sizeBytes: buffer.length, width: metadata.width, height: metadata.height };
    }
    // Keep useful detail, aspect ratio, EXIF orientation and transparency. Never
    // crop/upscale or lower quality without bound to force a tiny file.
    for (const [dimension, quality] of [[1600, 90], [1600, 84], [1440, 84], [1280, 84]]) {
      let pipeline = sharp(buffer, decoder).rotate().resize({ width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true }).timeout({ seconds: 20 });
      pipeline = format === 'jpeg' ? pipeline.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }) : pipeline.webp({ quality, alphaQuality: 100, effort: 4 });
      const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
      if (data.length <= MAX_STORED_BYTES) return { buffer: data, mimeType: `image/${format}`, extension: format === 'jpeg' ? 'jpg' : 'webp', sizeBytes: data.length, width: info.width, height: info.height };
    }
    throw imageError('This photo cannot fit the storage limit while retaining useful detail. Export a smaller photo and try again. The original was not stored.');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw imageError('This photo could not be safely optimized. Choose a valid JPG, PNG or WEBP photo. The original was not stored.');
  }
}

function optimizeImageBuffer(buffer, options) { return schedule(() => encode(buffer, options)); }
function optimizeImageFile(file, options) {
  return schedule(async () => {
    const stat = await fs.stat(file.path);
    if (!stat.isFile() || !stat.size || stat.size > MAX_SOURCE_BYTES) throw imageError('Choose a valid photo up to 20MB before compression.');
    return encode(await fs.readFile(file.path), options);
  });
}

module.exports = { optimizeImageBuffer, optimizeImageFile, MAX_SOURCE_BYTES, MAX_STORED_BYTES, MAX_DIMENSION };
