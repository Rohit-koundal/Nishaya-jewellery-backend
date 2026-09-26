const fs = require('fs/promises');
const path = require('path');
const upload = require('../middleware/uploadMiddleware');
const { isR2Configured, uploadImageToR2 } = require('../services/r2Upload');
const { isCloudinaryConfigured, uploadImage } = require('../services/cloudinaryUpload');
const { isLocalRequest } = require('../utils/imageUtils');
const { ApiError } = require('../utils/apiError');

function localFile(file) {
  const name = path.basename(file.filename || file.path || '');
  return { url: `/uploads/${name}`, publicId: name, provider: 'local' };
}

async function cleanup(files = []) {
  await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => null)));
}

async function assertRealImages(files = []) {
  for (const file of files) {
    const header = await fs.readFile(file.path).then((value) => value.subarray(0, 16));
    const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    const isPng = header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isWebp = header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!isJpeg && !isPng && !isWebp) throw new ApiError('VALIDATION_ERROR', 'One or more files are not valid JPG, PNG, or WEBP images');
  }
}

exports.middleware = (req, res, next) => upload.array('images', 4)(req, res, next);

exports.uploadReviewPhotos = async function uploadReviewPhotos(req, res, next) {
  try {
    if (!req.files?.length) throw new ApiError('VALIDATION_ERROR', 'Choose at least one review photo');
    await assertRealImages(req.files);
    if (!isR2Configured() && !isCloudinaryConfigured() && process.env.NODE_ENV === 'production' && !isLocalRequest(req)) {
      await cleanup(req.files);
      throw new ApiError('PERSISTENT_UPLOAD_STORAGE_REQUIRED', 'Review photos need Cloudflare R2 or Cloudinary in production', { statusCode: 503 });
    }
    let files;
    if (isR2Configured()) {
      files = await Promise.all(req.files.map((file) => uploadImageToR2(file, { folder: 'reviews' })));
      await cleanup(req.files);
    } else if (isCloudinaryConfigured()) {
      files = (await Promise.all(req.files.map((file) => uploadImage(file, { folder: 'reviews' })))).filter(Boolean);
      await cleanup(req.files);
    } else files = req.files.map(localFile);
    res.status(201).json({ files: files.map((file) => ({ url: file.url, publicId: file.publicId, provider: file.provider || (isR2Configured() ? 'r2' : isCloudinaryConfigured() ? 'cloudinary' : 'local') })) });
  } catch (error) {
    await cleanup(req.files || []);
    next(error);
  }
};
