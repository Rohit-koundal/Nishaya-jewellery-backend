const test = require('node:test');
const assert = require('node:assert/strict');
const { configuration, startSelfKeepAlive, INITIAL_DELAY_MS, INTERVAL_MS, REQUEST_TIMEOUT_MS, RETRY_DELAYS_MS } = require('../services/selfKeepAliveService');
const { LIVENESS_BODY } = require('../utils/livenessProbe');

const production = {
  NODE_ENV: 'production', RENDER: 'true', RENDER_SERVICE_TYPE: 'web',
  SELF_KEEP_ALIVE_ENABLED: 'true', RENDER_EXTERNAL_URL: 'https://nishaya-jewellery-backend.onrender.com',
};
const flush = async () => { for (let i = 0; i < 3; i += 1) await new Promise(resolve => setImmediate(resolve)); };

function clock() {
  let time = 0;
  const timers = new Set();
  return {
    timers,
    now: () => time,
    jump: ms => { time += ms; },
    setTimeout(fn, delay) {
      const timer = { at: time + delay, fn, unreferenced: false, unref() { this.unreferenced = true; } };
      timers.add(timer);
      return timer;
    },
    clearTimeout: timer => timers.delete(timer),
    async advance(ms) {
      const end = time + ms;
      for (let guard = 0; guard < 1000; guard += 1) {
        const next = [...timers].sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > end) break;
        time = Math.max(time, next.at);
        timers.delete(next);
        next.fn();
        await flush();
      }
      time = Math.max(time, end);
      await flush();
    },
  };
}

function success(url, body) {
  return new Response(body ?? `${LIVENESS_BODY}:${new URL(url).searchParams.get('probe')}`, { headers: { 'content-type': 'text/plain' } });
}

function harness(t, { env = production, fetchImpl = url => success(url), logger } = {}) {
  const timer = clock(), calls = [], logs = [];
  const options = {
    env, now: timer.now, setTimeoutFn: timer.setTimeout, clearTimeoutFn: timer.clearTimeout,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return fetchImpl(url, options); },
    logger: logger || { info: msg => logs.push(msg), warn: msg => logs.push(msg) },
  };
  const stop = startSelfKeepAlive(options);
  t.after(async () => { stop(); await flush(); });
  return { timer, calls, logs, stop, options };
}

test('worker is opt-in and ignores legacy master/frontend URL configuration', () => {
  assert.deepEqual(configuration({ ...production, SELF_KEEP_ALIVE_ENABLED: undefined }), { enabled: false });
  assert.deepEqual(configuration({ ...production, SELF_KEEP_ALIVE_ENABLED: 'false' }), { enabled: false });
  assert.equal(configuration({ ...production, PUBLIC_API_URL: 'https://samira.onrender.com', CONTROL_PLANE_URL: 'https://master.onrender.com' }).url,
    'https://nishaya-jewellery-backend.onrender.com/health/live');
});

test('local, test, queue-worker and preview processes never self-ping', () => {
  for (const overrides of [
    { NODE_ENV: 'development' }, { NODE_ENV: 'test' }, { RENDER: undefined },
    { RENDER_SERVICE_TYPE: 'worker' }, { RENDER_SERVICE_TYPE: undefined }, { IS_PULL_REQUEST: 'true' },
  ]) assert.equal(configuration({ ...production, ...overrides }).enabled, false);
});

test('malformed, credential-bearing, private and non-origin targets fail closed', () => {
  for (const url of [undefined, '', 'not a URL', 'http://nishaya.onrender.com', 'https://localhost', 'https://127.0.0.1',
    'https://[::1]', 'https://10.0.0.1', 'https://nishaya.onrender.com.evil.test', 'https://onrender.com',
    'https://user:secret@nishaya.onrender.com', 'https://nishaya.onrender.com:5000',
    'https://nishaya.onrender.com/api/orders', 'https://nishaya.onrender.com/?key=secret', 'https://nishaya.onrender.com/#secret']) {
    assert.equal(configuration({ ...production, RENDER_EXTERNAL_URL: url }).enabled, false, String(url));
  }
});

test('disabled and invalid configurations create no timers or requests', async t => {
  const h = harness(t, { env: { ...production, RENDER_EXTERNAL_URL: 'https://user:secret@localhost' } });
  await h.timer.advance(INTERVAL_MS * 2);
  assert.equal(h.calls.length, 0);
  assert.equal(h.timer.timers.size, 0);
  assert.match(h.logs.join('\n'), /Disabled/);
  assert.doesNotMatch(h.logs.join('\n'), /secret|user:/);
});

test('startup waits 10s then probes only its public liveness endpoint every five minutes', async t => {
  const h = harness(t);
  assert.equal(h.calls.length, 0);
  await h.timer.advance(INITIAL_DELAY_MS - 1);
  assert.equal(h.calls.length, 0);
  await h.timer.advance(1);
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(new URL(call.url).origin, 'https://nishaya-jewellery-backend.onrender.com');
  assert.equal(new URL(call.url).pathname, '/health/live');
  assert.equal(call.options.method, 'GET');
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.cache, 'no-store');
  assert.equal(call.options.headers.Authorization, undefined);
  assert.equal(call.options.body, undefined);
  assert.match(h.logs.join('\n'), /verified/);
  assert.ok([...h.timer.timers].every(timer => timer.unreferenced));
  await h.timer.advance(INTERVAL_MS);
  assert.equal(h.calls.length, 2);
  assert.notEqual(h.calls[0].url, h.calls[1].url, 'Every attempt must bypass old cached responses');
});

test('HTTP failures use three short retries then a five-minute pause', async t => {
  const h = harness(t, { fetchImpl: () => new Response('unavailable', { status: 503 }) });
  await h.timer.advance(INITIAL_DELAY_MS);
  assert.equal(h.calls.length, 1);
  for (const [index, delay] of RETRY_DELAYS_MS.entries()) {
    await h.timer.advance(delay - 1);
    assert.equal(h.calls.length, index + 1);
    await h.timer.advance(1);
    assert.equal(h.calls.length, index + 2);
  }
  await h.timer.advance(INTERVAL_MS - 1);
  assert.equal(h.calls.length, 4);
  await h.timer.advance(1);
  assert.equal(h.calls.length, 5);
  assert.match(h.logs.join('\n'), /HTTP_503/);
});

test('network errors are contained and raw error messages are never logged', async t => {
  const h = harness(t, { fetchImpl: () => { throw new Error('https://private-user:secret@example.test'); } });
  await h.timer.advance(INITIAL_DELAY_MS);
  assert.match(h.logs.join('\n'), /NETWORK_ERROR/);
  assert.doesNotMatch(h.logs.join('\n'), /secret|private-user|example\.test/);
  assert.equal(h.timer.timers.size, 1);
});

test('success after a failure resets retry cadence and emits one recovery log', async t => {
  let attempts = 0;
  const h = harness(t, { fetchImpl: url => { attempts += 1; if (attempts === 1) throw new Error('offline'); return success(url); } });
  await h.timer.advance(INITIAL_DELAY_MS + RETRY_DELAYS_MS[0]);
  assert.equal(h.calls.length, 2);
  assert.equal(h.logs.filter(log => log.includes('Recovered')).length, 1);
  await h.timer.advance(INTERVAL_MS - 1);
  assert.equal(h.calls.length, 2);
  await h.timer.advance(1);
  assert.equal(h.calls.length, 3);
});

test('hung transport is aborted at 20s; late completion cannot start duplicate loops', async t => {
  let release;
  const h = harness(t, { fetchImpl: url => new Promise(resolve => { release = () => resolve(success(url)); }) });
  await h.timer.advance(INITIAL_DELAY_MS);
  await h.timer.advance(REQUEST_TIMEOUT_MS - 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.signal.aborted, false);
  await h.timer.advance(1);
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.match(h.logs.join('\n'), /REQUEST_TIMEOUT/);
  release();
  await flush();
  assert.equal(h.timer.timers.size, 1);
  await h.timer.advance(RETRY_DELAYS_MS[0]);
  assert.equal(h.calls.length, 2);
});

test('deadline also covers a stalled response body', async t => {
  let body;
  const h = harness(t, { fetchImpl: () => new Response(new ReadableStream({ start(controller) { body = controller; } })) });
  await h.timer.advance(INITIAL_DELAY_MS + REQUEST_TIMEOUT_MS);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.match(h.logs.join('\n'), /REQUEST_TIMEOUT/);
  body.close();
  await flush();
  assert.equal(h.timer.timers.size, 1);
});

test('HTML, stale responses and oversized bodies never count as successful probes', async t => {
  let nextBody = '<html>Render is starting</html>';
  const h = harness(t, { fetchImpl: url => success(url, nextBody) });
  await h.timer.advance(INITIAL_DELAY_MS);
  nextBody = `${LIVENESS_BODY}:stale-nonce`;
  await h.timer.advance(RETRY_DELAYS_MS[0]);
  nextBody = 'x'.repeat(257);
  await h.timer.advance(RETRY_DELAYS_MS[1]);
  assert.equal(h.logs.filter(log => log.includes('UNEXPECTED_RESPONSE')).length, 3);
  assert.doesNotMatch(h.logs.join('\n'), /verified/);
});

test('only one worker can start in a process and cleanup is idempotent', async t => {
  const h = harness(t);
  assert.equal(startSelfKeepAlive(h.options), h.stop);
  assert.equal(h.timer.timers.size, 1);
  await h.timer.advance(INITIAL_DELAY_MS);
  assert.equal(h.calls.length, 1);
  h.stop(); h.stop();
  await h.timer.advance(INTERVAL_MS * 3);
  assert.equal(h.calls.length, 1);
  assert.equal(h.timer.timers.size, 0);
  const restartedStop = startSelfKeepAlive(h.options);
  t.after(restartedStop);
  assert.notEqual(restartedStop, h.stop);
  await h.timer.advance(INITIAL_DELAY_MS);
  assert.equal(h.calls.length, 2);
});

test('shutdown cancels pending requests and schedules no retry even if fetch ignores abort', async t => {
  const h = harness(t, { fetchImpl: () => new Promise(() => {}) });
  await h.timer.advance(INITIAL_DELAY_MS);
  h.stop();
  await flush();
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.equal(h.timer.timers.size, 0);
  await h.timer.advance(INTERVAL_MS);
  assert.equal(h.calls.length, 1);
});

test('delayed timer sends a single catch-up request, not a backlog of pings', async t => {
  const h = harness(t);
  h.timer.jump(INTERVAL_MS * 4);
  await h.timer.advance(0);
  assert.equal(h.calls.length, 1);
  assert.match(h.logs.join('\n'), /Timer was delayed/);
  assert.equal(h.timer.timers.size, 1);
});

test('logger failures do not stop successful scheduling', async t => {
  const h = harness(t, { logger: { info() { throw new Error('Log unavailable'); }, warn() { throw new Error('Log unavailable'); } } });
  await h.timer.advance(INITIAL_DELAY_MS + INTERVAL_MS);
  assert.equal(h.calls.length, 2);
});
