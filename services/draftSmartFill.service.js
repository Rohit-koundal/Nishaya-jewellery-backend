const crypto = require('node:crypto');
const ProductDraft = require('../models/ProductDraft');
const { andFilter } = require('./storeService');
const { readConfiguration } = require('./masterConfigurationService');
const { analyzeListing } = require('../controllers/productSmartFillController');
const { ApiError } = require('../utils/apiError');

const COPY_FIELDS = ['shortDescription', 'description', 'highlights', 'tags', 'metaTitle', 'metaDescription', 'metaKeywords'];
const FIELDS = ['name', 'category', 'subCategory', 'description', 'shortDescription', 'colors', 'tags', 'highlights', 'fabric', 'occasion', 'sizes', 'sizingMode', 'price', 'originalPrice', 'brand', 'careInstructions', 'returnPolicy', 'countryOfOrigin', 'manufacturerDetails', 'warranty'];
const MATRIX_FIELDS = new Set(['name', 'category', 'subCategory', 'sizes', 'sizingMode', 'colors']);
const empty = value => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
const plain = draft => typeof draft.toObject === 'function' ? draft.toObject({ flattenMaps: true }) : draft;
const canonical = value => value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !value.toHexString
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : Array.isArray(value) ? value.map(canonical) : value;
function inputs(draft, notes, preferences) {
  const data = plain(draft);
  const photos = [...new Set([...(data.images || []).filter(image => image.primary).map(image => image.url), ...(data.images || []).map(image => image.url), data.image].filter(Boolean))].slice(0, 3);
  const existing = Object.fromEntries(['name', 'category', 'subCategory', 'fabric', 'colors', 'sizes', 'occasion', 'description', 'shortDescription', 'highlights', 'attributeValues', 'brand', 'careInstructions', 'returnPolicy', 'countryOfOrigin', 'manufacturerDetails', 'warranty'].map(key => [key, key === 'category' ? String(data.category?._id || data.category || '') : data[key]]));
  return { notes, imageUrls: photos, existing, copyPreferences: preferences };
}
function fingerprint(draft, notes, preferences, configuration) {
  // Include commercial/manual fields too: edits must invalidate reuse, even
  // though those values are not interpreted as new AI evidence.
  const data = plain(draft);
  const content = { ...data, supplierNotes: notes }; for (const key of ['smartFill', 'updatedAt', 'createdAt', '__v', 'lastSavedBy', 'revision']) delete content[key];
  return crypto.createHash('sha256').update(JSON.stringify(canonical({ content, inputs: inputs(data, notes, preferences), structure: configuration.structure, version: 1 }))).digest('hex');
}
function buildPatch(result, draft, refreshFields = []) {
  const data = plain(draft); const suggestion = result.suggestion || {}; const patch = {};
  const replace = new Set(refreshFields.filter(field => COPY_FIELDS.includes(field)));
  for (const field of FIELDS) {
    const value = suggestion[field]; if (empty(value)) continue;
    if (data.variants?.length && MATRIX_FIELDS.has(field)) continue;
    const key = field === 'price' ? 'sellingPrice' : field;
    if (!empty(data[key]) && data[key] !== 0 && !(field === 'sizingMode' && data[key] === 'auto') && !replace.has(key)) continue;
    if (['price', 'originalPrice'].includes(field) && (!result.fieldSources?.[field] || !Number.isFinite(value) || value <= 0)) continue;
    patch[key] = value;
  }
  const attributes = { ...data.attributeValues };
  for (const [key, value] of Object.entries(suggestion.attributeValues || {})) if (empty(attributes[key]) && typeof value === 'string' && value.trim()) attributes[key] = value;
  if (JSON.stringify(attributes) !== JSON.stringify(data.attributeValues || {})) patch.attributeValues = attributes;
  const next = { ...data, ...patch };
  const price = Number(next.sellingPrice ?? next.price); const mrp = Number(next.originalPrice);
  if (price > 0 && mrp > 0 && mrp < price) { delete patch.sellingPrice; delete patch.originalPrice; }
  if (patch.sellingPrice !== undefined) patch.price = patch.sellingPrice;
  if (patch.category && String(patch.category) !== String(data.category || '') && !patch.subCategory) patch.subCategory = '';
  if (!data.sku && (patch.name || data.name)) patch.sku = 'NJ-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const copy = { ...data, ...patch };
  const seo = { metaTitle: String(copy.name || '').slice(0, 60), metaDescription: String(copy.shortDescription || copy.description || '').replace(/\s+/g, ' ').slice(0, 160), metaKeywords: (copy.tags || []).join(', ') };
  for (const [key, value] of Object.entries(seo)) if (value && (empty(data[key]) || replace.has(key))) patch[key] = value;
  return patch;
}

async function processDraft(req, { analyze = analyzeListing } = {}) {
  const query = andFilter({ _id: req.params.id }, req.tenantFilter);
  const draft = await ProductDraft.findOne(query);
  if (!draft) throw new ApiError('NOT_FOUND', 'Draft not found');
  if (draft.status !== 'draft') throw new ApiError('DRAFT_STALE', 'Only active drafts can be analysed.', { statusCode: 409 });
  if (req.body.baseRevision !== undefined && (!Number.isSafeInteger(req.body.baseRevision) || req.body.baseRevision !== Number(draft.revision || 0))) throw new ApiError('DRAFT_STALE', 'This draft changed. Reload its current details before starting analysis.', { statusCode: 409 });
  const notes = req.body.notes ?? draft.supplierNotes ?? '';
  if (typeof notes !== 'string' || notes.length > 7000) throw new ApiError('VALIDATION_ERROR', 'Keep supplier notes under 7,000 characters.');
  const refreshFields = req.body.refreshFields ?? [];
  if (!Array.isArray(refreshFields) || refreshFields.some(field => !COPY_FIELDS.includes(field))) throw new ApiError('VALIDATION_ERROR', 'Select only listing-copy fields to regenerate.');
  const preferences = req.body.copyPreferences || plain(draft).smartFill?.copyPreferences || {};
  if (typeof preferences !== 'object' || Array.isArray(preferences) || Object.entries(preferences).some(([key, value]) => !['language', 'tone'].includes(key) || typeof value !== 'string' || value.length > 120)) throw new ApiError('VALIDATION_ERROR', 'Choose valid content language and tone.');
  const configuration = await readConfiguration(draft.storeId);
  const hash = fingerprint(draft, notes, preferences, configuration);
  if (!refreshFields.length && draft.smartFill?.state === 'completed' && draft.smartFill.fingerprint === hash) return { draft, cached: true };
  const runId = crypto.randomUUID();
  const revision = Number(draft.revision || 0);
  const lock = await ProductDraft.findOneAndUpdate(andFilter(query, { status: 'draft', revision, $or: [{ 'smartFill.state': { $ne: 'running' } }, { 'smartFill.startedAt': { $lt: new Date(Date.now() - 90000) } }] }), {
    $set: { supplierNotes: notes, smartFill: { state: 'running', runId, startedAt: new Date(), message: 'Analysing product details', copyPreferences: preferences } },
  }, { new: true });
  if (!lock) throw new ApiError('DUPLICATE_REQUEST', 'This draft changed or is already being analysed. Refresh; an interrupted analysis can resume after 90 seconds.');
  const guard = andFilter(query, { 'smartFill.runId': runId, 'smartFill.state': 'running' });
  try {
    const result = await analyze(req, inputs(draft, notes, preferences), AbortSignal.timeout(75000));
    if (result.errorCode || result.mode !== 'ai') throw Object.assign(new Error(result.warnings?.[0] || 'Photo AI is not configured. Set up Gemini on the backend.'), { errorCode: result.errorCode || 'SMART_FILL_UNAVAILABLE' });
    const patch = result.requiresReview ? {} : buildPatch(result, draft, refreshFields);
    const state = result.requiresReview ? 'review' : 'completed';
    const next = { ...plain(draft), ...patch, supplierNotes: notes };
    const metadata = { state, runId, startedAt: lock.smartFill.startedAt, completedAt: new Date(), copyPreferences: preferences,
      fingerprint: fingerprint(next, notes, preferences, configuration), fields: Object.keys(patch), fieldSources: result.fieldSources,
      warnings: result.warnings, message: result.requiresReview ? 'Review grouping/photos before analysis.' : 'Listing details saved. Review before publishing.' };
    const saved = await ProductDraft.findOneAndUpdate(andFilter(guard, { revision, status: 'draft' }), { $set: { ...patch, smartFill: metadata, lastSavedBy: req.user._id }, $inc: { revision: 1 } }, { new: true, runValidators: true });
    if (!saved) throw Object.assign(new Error('Draft changed during analysis. Your edits were kept. Review and run again.'), { errorCode: 'DRAFT_STALE' });
    return { draft: saved, cached: false };
  } catch (error) {
    const errorCode = error.errorCode || 'SMART_FILL_FAILED';
    const message = error.errorCode ? error.message : 'Product analysis could not finish. Your existing details were kept; try this product again.';
    const saved = await ProductDraft.findOneAndUpdate(guard, { $set: { 'smartFill.state': errorCode === 'DRAFT_STALE' ? 'review' : 'failed', 'smartFill.message': message, 'smartFill.errorCode': errorCode, 'smartFill.completedAt': new Date() } }, { new: true });
    return { draft: saved || await ProductDraft.findOne(query) || draft, errorCode, message };
  }
}
module.exports = { processDraft, buildPatch, inputs, fingerprint, COPY_FIELDS };
