const jwt = require('jsonwebtoken');
const { getJwtRefreshSecret, getJwtSecret } = require('../config/env');

function tokenPayload(user) {
  const id = user._id || user.id || user;
  return {
    id,
    userId: id,
    phone: user.phone,
    name: user.name,
    role: user.role,
    activeMode: user.activeMode,
    authSessionVersion: Number(user.authSessionVersion || 0),
    offlineSession: !!user.offlineSession,
    ...(user.$locals?.masterAuthenticated && user.masterSessionVersion ? { masterSessionVersion: user.masterSessionVersion } : {}),
    ...(user.$locals?.localOwnerDemo ? { localOwnerDemo: true } : {}),
    ...(user.$locals?.hostedOwnerDemo ? { hostedOwnerDemo: true } : {}),
  };
}

function generateToken(user) {
  // Admin work should not depend on a cross-site refresh cookie every 15
  // minutes. Use the server-resolved account role, including customer mode.
  // protect() still checks blocking, role changes and session revocation.
  return jwt.sign(tokenPayload(user), getJwtSecret(), {
    expiresIn: user.role === 'admin' ? '24h' : (process.env.JWT_EXPIRES_IN || '15m'),
  });
}

function generateRefreshToken(user) {
  return jwt.sign(
    { ...tokenPayload(user), tokenType: 'refresh' },
    getJwtRefreshSecret(),
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' },
  );
}

module.exports = { generateRefreshToken, generateToken };
