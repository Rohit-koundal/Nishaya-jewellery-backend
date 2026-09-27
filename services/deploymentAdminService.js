const User = require('../models/User');
const { getAdminPhones, getOwnerPhone, getAdminEmail, isRetiredAdminPhone } = require('../config/deploymentAdmin');
const { normalizePhone } = require('../utils/phoneUtils');
const { logAudit } = require('./auditService');

// Run on startup and on session reads: changing an env allowlist must also
// invalidate previously issued sessions, not just affect new registrations.
async function reconcileAdminAccess(user) {
  if (!user || user.offlineSession) return user;
  const configured = getAdminPhones().includes(normalizePhone(user.phone));
  const formerOwner = user.systemRole === 'MASTER_OWNER' && normalizePhone(user.phone) !== getOwnerPhone();
  const revokeAdmin = !configured && (isRetiredAdminPhone(user.phone) || user.adminAccessSource === 'ENV' || formerOwner);
  const hasAdmin = user.role === 'admin' || user.availableModes?.includes('admin') || user.activeMode === 'admin';
  if (!formerOwner && !(revokeAdmin && hasAdmin)) return user;
  const set = { systemRole: 'USER' };
  if (revokeAdmin) {
    set.role = 'customer';
    set.availableModes = user.availableModes?.includes('seller') ? ['customer', 'seller'] : ['customer'];
    set.activeMode = user.activeMode === 'seller' && set.availableModes.includes('seller') ? 'seller' : 'customer';
  }
  const updated = await User.findOneAndUpdate({ _id: user._id, phone: user.phone, $or: [
    { systemRole: 'MASTER_OWNER' }, ...(revokeAdmin ? [{ role: 'admin' }, { availableModes: 'admin' }, { activeMode: 'admin' }] : []),
  ] }, {
    $set: set, $unset: { masterSessionVersion: 1, ...(revokeAdmin ? { adminAccessSource: 1 } : {}) }, $inc: { authSessionVersion: 1 },
  }, { new: true }).select('-password +masterSessionVersion +authSessionVersion +adminAccessSource');
  if (updated) {
    await logAudit({ source: 'SYSTEM', action: 'DEPLOYMENT_ADMIN_ACCESS_REVOKED', entityType: 'User', entityId: user._id,
      before: { role: user.role, systemRole: user.systemRole }, after: { role: updated.role, systemRole: updated.systemRole }, summary: 'Deployment admin configuration changed; previous sessions invalidated.' });
    return updated;
  }
  // A concurrent request may have already revoked it. Never reuse stale roles.
  return User.findById(user._id).select('-password +masterSessionVersion +authSessionVersion +adminAccessSource');
}

async function reconcileDeploymentAdmins() {
  const users = await User.find({ $or: [{ role: 'admin' }, { systemRole: 'MASTER_OWNER' }, { availableModes: 'admin' }] }).select('-password +masterSessionVersion +authSessionVersion +adminAccessSource');
  for (const user of users) await reconcileAdminAccess(user);
}

async function applyOwnerEmail(user) {
  const email = getAdminEmail();
  if (!email || normalizePhone(user.phone) !== getOwnerPhone() || user.email === email) return;
  // Never merge accounts or take an email already attached to another customer.
  // Verified/custom profile emails keep their existing verification workflow.
  if (user.email && !/^phone\+.*@(?:samira|nishaya)\.local$/i.test(user.email)) return;
  if (await User.exists({ email, ...(user._id ? { _id: { $ne: user._id } } : {}) })) return;
  user.email = email;
  user.isEmailVerified = false;
}

module.exports = { reconcileAdminAccess, reconcileDeploymentAdmins, applyOwnerEmail };
