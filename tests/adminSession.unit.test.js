const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { generateToken, generateRefreshToken } = require('../utils/generateToken');

test.beforeEach(t => {
  const values = {
    JWT_SECRET: 'isolated-admin-session-access-secret',
    JWT_REFRESH_SECRET: 'isolated-admin-session-refresh-secret',
    JWT_EXPIRES_IN: '',
    JWT_REFRESH_EXPIRES_IN: '',
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
});

const account = overrides => ({
  _id: '0123456789abcdef01234567', role: 'admin', activeMode: 'admin',
  authSessionVersion: 3, ...overrides,
});
const lifetime = token => { const claims = jwt.decode(token); return claims.exp - claims.iat; };

for (const activeMode of ['admin', 'customer']) {
  test(`admin access lasts 24 hours in ${activeMode} mode and expires at the boundary`, () => {
    const token = generateToken(account({ activeMode }));
    const claims = jwt.decode(token);
    assert.equal(lifetime(token), 86400);
    assert.equal(claims.authSessionVersion, 3);
    assert.equal(jwt.verify(token, process.env.JWT_SECRET, { clockTimestamp: claims.iat + 86399 }).id, account()._id);
    assert.throws(() => jwt.verify(token, process.env.JWT_SECRET, { clockTimestamp: claims.iat + 86400 }), { name: 'TokenExpiredError' });
  });
}

test('customers and sellers keep the existing 15-minute default regardless of claimed mode', () => {
  for (const role of ['customer', 'seller', undefined]) {
    assert.equal(lifetime(generateToken(account({ role, activeMode: 'admin', availableModes: ['admin'] }))), 900);
  }
});

test('the general access expiry still configures customers but cannot shorten admin access', () => {
  process.env.JWT_EXPIRES_IN = '5m';
  assert.equal(lifetime(generateToken(account({ role: 'customer' }))), 300);
  assert.equal(lifetime(generateToken(account())), 86400);
});

test('refresh expiry and token type are unchanged for admins and customers', () => {
  for (const role of ['admin', 'customer']) {
    const token = generateRefreshToken(account({ role }));
    const claims = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    assert.equal(lifetime(token), 30 * 86400);
    assert.equal(claims.tokenType, 'refresh');
    assert.equal(claims.authSessionVersion, 3);
  }
  process.env.JWT_REFRESH_EXPIRES_IN = '2d';
  assert.equal(lifetime(generateRefreshToken(account())), 2 * 86400);
});

test('owner authentication and session-version claims remain attached to the longer token', () => {
  const token = generateToken(account({ masterSessionVersion: 'verified-owner-session', $locals: { masterAuthenticated: true } }));
  const claims = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(claims.masterSessionVersion, 'verified-owner-session');
  assert.equal(claims.authSessionVersion, 3);
  assert.equal(lifetime(token), 86400);
  assert.equal(jwt.decode(generateToken(account({ masterSessionVersion: 'unverified' }))).masterSessionVersion, undefined);
});
