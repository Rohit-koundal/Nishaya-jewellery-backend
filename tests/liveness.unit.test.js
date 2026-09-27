const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { LIVENESS_PATH, LIVENESS_BODY, sendLiveness } = require('../utils/livenessProbe');
const { startSelfKeepAlive, INITIAL_DELAY_MS } = require('../services/selfKeepAliveService');

let server, base;
test.before(async () => {
  const app = express();
  app.get(LIVENESS_PATH, sendLiveness);
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

test('public liveness is tiny, uncached and does not require a database or credentials', async () => {
  const response = await fetch(`${base}${LIVENESS_PATH}`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), LIVENESS_BODY);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match(response.headers.get('content-type'), /text\/plain/);
});

test('valid nonce is echoed exactly and malformed/array probes are rejected', async () => {
  const nonce = 'dfbdd383-fb6e-4bcd-8a82-7a39a2e54696';
  const response = await fetch(`${base}${LIVENESS_PATH}?probe=${nonce}`);
  assert.equal(await response.text(), `${LIVENESS_BODY}:${nonce}`);
  for (const suffix of ['?probe=arbitrary', '?probe=', '?probe[]=one', '?probe[x]=one', '?probe=one&probe=two']) {
    const invalid = await fetch(`${base}${LIVENESS_PATH}${suffix}`);
    assert.equal(invalid.status, 400);
    assert.match(invalid.headers.get('cache-control'), /no-store/);
  }
});

test('liveness cannot execute mutations', async () => {
  const response = await fetch(`${base}${LIVENESS_PATH}`, { method: 'POST' });
  assert.equal(response.status, 404);
});

test('worker verifies the real Express response using Node fetch without hitting production', async t => {
  let verified, rejectProbe, deadline;
  const result = new Promise((resolve, reject) => { verified = resolve; rejectProbe = reject; });
  t.after(() => clearTimeout(deadline));
  deadline = setTimeout(() => rejectProbe(new Error('Local probe did not complete')), 5000);
  const stop = startSelfKeepAlive({
    env: { SELF_KEEP_ALIVE_ENABLED: 'true', NODE_ENV: 'production', RENDER: 'true', RENDER_SERVICE_TYPE: 'web', RENDER_EXTERNAL_URL: 'https://test-api.onrender.com' },
    setTimeoutFn: (fn, delay) => setTimeout(fn, delay === INITIAL_DELAY_MS ? 0 : delay),
    fetchImpl: (url, options) => {
      const target = new URL(url);
      assert.equal(target.origin, 'https://test-api.onrender.com');
      return fetch(`${base}${target.pathname}${target.search}`, options);
    },
    logger: { info(message) { if (message.includes('verified')) verified(); }, warn: message => rejectProbe(new Error(message)) },
  });
  t.after(stop);
  await result;
});
