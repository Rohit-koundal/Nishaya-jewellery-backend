const { asyncHandler } = require('../middleware/validate');
const { requireObjectId } = require('../utils/validators');
const { processDraft } = require('../services/draftSmartFill.service');
exports.fill = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'draft id');
  const result = await processDraft(req);
  const draft = result.draft.toObject({ flattenMaps: true });
  res.json({ success: !result.errorCode, data: draft, cached: Boolean(result.cached), ...(result.errorCode ? { code: result.errorCode, message: result.message } : {}) });
});
