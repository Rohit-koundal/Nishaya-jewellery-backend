const { ApiError } = require('../utils/apiError');
function readPhotoGroups(raw, count, groupMode) {
  let groups;
  if (raw !== undefined) {
    try { groups = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new ApiError('VALIDATION_ERROR', 'Invalid photo groups'); }
  } else groups = groupMode === 'single' ? [{ fileIndexes: Array.from({ length: count }, (_, i) => i) }] : Array.from({ length: count }, (_, i) => ({ fileIndexes: [i] }));
  const used = new Set();
  if (!Array.isArray(groups) || !groups.length || groups.length > 30) throw new ApiError('VALIDATION_ERROR', 'Choose between 1 and 30 product groups');
  for (const group of groups) {
    if (!group || !Array.isArray(group.fileIndexes) || !group.fileIndexes.length || group.fileIndexes.length > 12) throw new ApiError('VALIDATION_ERROR', 'Each product needs 1–12 photos');
    for (const index of group.fileIndexes) {
      if (!Number.isInteger(index) || index < 0 || index >= count || used.has(index)) throw new ApiError('VALIDATION_ERROR', 'Each photo must belong to exactly one product');
      used.add(index);
    }
    if (group.reference !== undefined && (typeof group.reference !== 'string' || group.reference.length > 100)) throw new ApiError('VALIDATION_ERROR', 'Keep product references under 100 characters');
  }
  if (used.size !== count) throw new ApiError('VALIDATION_ERROR', 'Assign every photo to a product');
  return groups;
}
module.exports = { readPhotoGroups };
