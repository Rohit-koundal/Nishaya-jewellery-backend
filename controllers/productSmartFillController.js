const rateLimit = require('express-rate-limit');
const Category = require('../models/Category');
const { andFilter } = require('../services/storeService');
const { readConfiguration, productAttributeContext, validateAttributeValue } = require('../services/masterConfigurationService');
const { analyzeProductContext, enabled } = require('../services/productImportContext.service');
const { readProductPhoto } = require('../services/productSmartFillMedia');
const { asyncHandler } = require('../middleware/validate');
const { ApiError } = require('../utils/apiError');

const active = new Set();
const clean = (value, max = 3000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const factFields = { name: 'Name', category: 'Category', subCategory: 'Product type', fabric: 'Fabric', colors: 'Colours', sizes: 'Sizes', occasion: 'Occasion', shortDescription: 'Short description', highlights: 'Highlights', description: 'Description' };
const statedFields = { brand: 'Brand', careInstructions: 'Care instructions', returnPolicy: 'Return policy', countryOfOrigin: 'Country of origin', manufacturerDetails: 'Manufacturer details', warranty: 'Warranty' };
function sourceText(body, categories, attributes) {
  const existing = body.existing && typeof body.existing === 'object' && !Array.isArray(body.existing) ? body.existing : {};
  const lines = Object.entries({ ...factFields, ...statedFields }).map(([key, label]) => {
    const raw = key === 'category' ? categories.find(item => String(item._id) === existing.category)?.name : existing[key];
    const value = clean(Array.isArray(raw) ? raw.filter(item => typeof item === 'string').join(', ') : raw, key === 'description' ? 2000 : 200);
    return value ? label + ': ' + value.replace(/\r?\n/g, ' ') : '';
  }).filter(Boolean);
  for (const attribute of attributes) {
    const value = clean(existing.attributeValues?.[attribute.key], 500);
    if (value) lines.push(attribute.label + ': ' + value);
  }
  // Supplier notes go first. Previously entered prices and stock are never
  // reinterpreted as new commercial evidence.
  return [clean(body.notes, 7000), ...lines].filter(Boolean).join('\n').slice(0, 10000);
}

exports.limiter = rateLimit({ windowMs: 60000, max: 12, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => String(req.user._id),
  message: { message: 'Smart Fill has received several requests. Please wait a minute before trying again.' },
});
exports.status = (_req, res) => res.json({ enabled: enabled(), notesSupported: true, maxPhotos: 3 });
function validateRequest(body) {
  if (body?.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > 7000)) throw new ApiError('VALIDATION_ERROR', 'Keep supplier notes under 7,000 characters.');
  const urls = body?.imageUrls ?? [];
  if (!Array.isArray(urls) || urls.length > 3 || urls.some(url => typeof url !== 'string' || url.length > 4096)) throw new ApiError('VALIDATION_ERROR', 'Select up to three uploaded product photos.');
  if (body.copyPreferences !== undefined && (!body.copyPreferences || typeof body.copyPreferences !== 'object' || Array.isArray(body.copyPreferences) || Object.entries(body.copyPreferences).some(([key, value]) => !['language', 'tone'].includes(key) || typeof value !== 'string' || value.length > 120))) throw new ApiError('VALIDATION_ERROR', 'Choose valid content language and tone.');
}
async function analyzeListing(req, body, signal) {
  validateRequest(body);
  const urls = body?.imageUrls ?? [];
    const [categories, configuration] = await Promise.all([
      Category.find(andFilter({ isActive: { $ne: false }, isArchived: { $ne: true } }, req.tenantFilter)).select('_id name').limit(100).lean(), readConfiguration(req.store?._id),
    ]);
    const configured = new Map((configuration.structure.attributes || []).map(attribute => [attribute.key, attribute]));
    for (const definition of configuration.structure.categoryDefinitions || []) for (const attribute of definition.attributes || []) {
      if (attribute && typeof attribute === 'object' && attribute.key && !configured.has(attribute.key)) configured.set(attribute.key, attribute);
    }
    const attributes = [...configured.values()];
    const caption = sourceText(body || {}, categories, attributes);
    if (!caption && !urls.length) throw new ApiError('VALIDATION_ERROR', 'Add a product photo, supplier notes or a few product details first.');
    if (!enabled() && !caption) throw new ApiError('SMART_FILL_UNAVAILABLE', 'Photo analysis needs Gemini configured on the backend. You can still paste supplier notes to fill stated details.');
    const images = []; const warnings = [];
    if (enabled()) {
      for (const url of [...new Set(urls)]) {
        try { images.push(await readProductPhoto(url, signal)); }
        catch (error) { if (signal.aborted) throw error; warnings.push('A selected photo could not be read. Re-upload it for photo analysis.'); }
      }
      if (urls.length && !images.length && !caption) throw new ApiError('SMART_FILL_MEDIA', warnings[0]);
    }
    const suggestion = await analyzeProductContext({ caption, images, categories, attributes, signal, catalogCopy: true, copyPreferences: body.copyPreferences });
    // Configured specifications also work in notes-only mode, but only for a
    // labelled, verbatim value. There are no inferred warranty/material claims.
    suggestion.attributeValues = { ...suggestion.attributeValues };
    for (const attribute of attributes) {
      const labels = [attribute.label, attribute.key].map(value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      const match = caption.match(new RegExp(`(?:^|\\n)\\s*(?:${labels})\\s*[:=]\\s*([^\\n]+)`, 'i'));
      if (match && !suggestion.attributeValues[attribute.key]) {
        suggestion.attributeValues[attribute.key] = clean(match[1], 500);
        suggestion.fieldSources['attribute.' + attribute.key] = { source: 'caption', quote: match[0].trim() };
      }
    }
    // Validate specifications using the same category inheritance and allowed
    // values as normal product creation, but leave missing facts for review.
    const selectedCategory = body.existing?.category || suggestion.category;
    const { definitions } = await productAttributeContext({ category: selectedCategory, subCategory: body.existing?.subCategory || suggestion.subCategory, storeId: req.store?._id }, {}, configuration);
    const validAttributes = {};
    for (const definition of definitions) {
      const value = suggestion.attributeValues[definition.key];
      if (value === undefined) continue;
      try { const cleaned = validateAttributeValue(definition, value); if (cleaned) validAttributes[definition.key] = cleaned; }
      catch { warnings.push(`Confirm ${definition.label}; its source value does not match the configured options.`); }
    }
    suggestion.attributeValues = validAttributes;
    for (const [field, label] of Object.entries(statedFields)) {
      const match = caption.match(new RegExp(`(?:^|\\n)\\s*${label}\\s*[:=]\\s*([^\\n]+)`, 'i'));
      if (match) { suggestion[field] = clean(match[1], 500); suggestion.fieldSources[field] = { source: 'caption', quote: match[0].trim() }; }
    }
    if (suggestion.contextStatus === 'failed') warnings.push(suggestion.contextError);
    if (!enabled()) warnings.push('Photo AI is not configured. These suggestions use only the details stated in your notes and form.');
    if (suggestion.priceAmbiguous || suggestion.multipleProducts) warnings.push('More than one price or product may be present. Confirm the product and enter its price manually.');
    if (configuration.structure.features?.sizing === false) { delete suggestion.sizes; delete suggestion.sizingMode; delete suggestion.sizeChart; }
    // Only listing data is returned. No credentials, model configuration or
    // provider responses are included, and nothing is saved or published here.
    const fields = ['name', 'category', 'subCategory', 'description', 'shortDescription', 'colors', 'tags', 'highlights', 'fabric', 'occasion', 'sizes', 'sizingMode', 'price', 'originalPrice', 'attributeValues', ...Object.keys(statedFields)];
    const data = Object.fromEntries(fields.filter(field => suggestion[field] !== undefined).map(field => [field, suggestion[field]]));
    return { suggestion: data, fieldSources: suggestion.fieldSources || {}, mode: suggestion.contextStatus === 'completed' ? 'ai' : 'notes', warnings: [...new Set(warnings)],
      // Machine-readable, sanitized failure state lets a batch stop on quota or
      // account errors instead of saving notes-only fallback as completed AI work.
      ...(suggestion.contextErrorCode ? { errorCode: suggestion.contextErrorCode } : {}),
      requiresReview: Boolean(suggestion.multipleProducts || (urls.length && images.length < new Set(urls).size && enabled())),
    };
}
exports.analyzeListing = analyzeListing;
exports.fill = asyncHandler(async (req, res) => {
  validateRequest(req.body || {});
  const key = String(req.user._id);
  if (active.has(key)) throw new ApiError('DUPLICATE_REQUEST', 'A Smart Fill request is already running. Wait for it to finish.');
  active.add(key);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(75000)]);
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', cancel);
  try {
    res.json(await analyzeListing(req, req.body || {}, signal));
  } catch (error) {
    if (signal.aborted && !controller.signal.aborted) throw new ApiError('SMART_FILL_TIMEOUT', 'Smart Fill took too long. Try again with fewer photos, or paste the product details.');
    if (!controller.signal.aborted) throw error;
  } finally { active.delete(key); res.off('close', cancel); }
});
exports.sourceText = sourceText;
