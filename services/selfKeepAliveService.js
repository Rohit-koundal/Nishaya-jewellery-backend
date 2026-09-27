const { randomUUID } = require('node:crypto');
const { LIVENESS_PATH, LIVENESS_BODY } = require('../utils/livenessProbe');

const INITIAL_DELAY_MS = 10000;
const INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20000;
const RETRY_DELAYS_MS = [15000, 30000, 60000];
const MAX_RESPONSE_BYTES = 256;
let activeStop;

function configuration(env = process.env) {
  if (String(env.SELF_KEEP_ALIVE_ENABLED).trim().toLowerCase() !== 'true') return { enabled: false };
  // Opt-in and web-process-only: no localhost, queue workers or preview traffic.
  if (env.NODE_ENV !== 'production' || env.RENDER !== 'true' || env.RENDER_SERVICE_TYPE !== 'web' || env.IS_PULL_REQUEST === 'true') {
    return { enabled: false, reason: 'Requires a production Render web service (not a preview).' };
  }
  try {
    // Deliberately do not use PUBLIC_API_URL or CONTROL_PLANE_URL: older client
    // deployments can still contain the master/frontend URL in those fields.
    const url = new URL(String(env.RENDER_EXTERNAL_URL || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash
      || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?\.onrender\.com$/i.test(url.hostname)) throw new Error('Invalid origin');
    return { enabled: true, url: new URL(LIVENESS_PATH, url.origin).href };
  } catch {
    return { enabled: false, reason: 'RENDER_EXTERNAL_URL must be this service\'s public HTTPS onrender.com origin.' };
  }
}

async function readSmallBody(response) {
  if (!response.body) throw new Error('UNEXPECTED_RESPONSE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('UNEXPECTED_RESPONSE');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

function startSelfKeepAlive({
  env = process.env,
  fetchImpl = globalThis.fetch,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = Date.now,
  uuid = randomUUID,
  logger = console,
} = {}) {
  if (activeStop) return activeStop;
  const config = configuration(env);
  const log = (level, message) => {
    // A failed probe (or log destination) must never crash the commerce API.
    try { logger[level]?.(`[self-keep-alive] ${message}`); } catch { /* best effort */ }
  };
  if (!config.enabled) {
    if (config.reason) log('warn', `Disabled: ${config.reason}`);
    return () => {};
  }
  if (typeof fetchImpl !== 'function') {
    log('warn', 'Disabled: this Node runtime does not provide fetch.');
    return () => {};
  }

  let stopped = false;
  let pulseTimer;
  let deadlineTimer;
  let controller;
  let inFlight = false;
  let retryIndex = 0;
  let failures = 0;
  let successes = 0;
  let dueAt;

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeoutFn(pulseTimer);
    clearTimeoutFn(deadlineTimer);
    controller?.abort(new Error('STOPPED'));
    if (activeStop === stop) activeStop = undefined;
  }

  function schedule(delay) {
    if (stopped) return;
    dueAt = now() + delay;
    pulseTimer = setTimeoutFn(() => { void tick(); }, delay);
    pulseTimer.unref?.();
  }

  async function tick() {
    if (stopped || inFlight) return;
    pulseTimer = undefined;
    inFlight = true;
    const lateBy = now() - dueAt;
    if (lateBy > 60000) log('warn', `Timer was delayed by ${Math.floor(lateBy / 1000)}s; probing now without catch-up bursts.`);
    const requestController = new AbortController();
    controller = requestController;
    let onAbort;
    let delay = INTERVAL_MS;
    try {
      // The deadline includes DNS/TLS, response headers AND the response body.
      // Promise.race also releases the scheduler if a transport ignores abort.
      const cancelled = new Promise((_, reject) => {
        onAbort = () => reject(requestController.signal.reason || new Error('REQUEST_ABORTED'));
        requestController.signal.addEventListener('abort', onAbort, { once: true });
      });
      deadlineTimer = setTimeoutFn(() => requestController.abort(new Error('REQUEST_TIMEOUT')), REQUEST_TIMEOUT_MS);
      deadlineTimer.unref?.();
      const probe = async () => {
        const nonce = uuid();
        const url = new URL(config.url);
        url.searchParams.set('probe', nonce);
        const response = await fetchImpl(url.href, {
          method: 'GET', signal: requestController.signal, redirect: 'error', cache: 'no-store',
          headers: { Accept: 'text/plain', 'Cache-Control': 'no-cache', 'User-Agent': 'Nishaya-Self-KeepAlive/1.0' },
        });
        if (requestController.signal.aborted) throw requestController.signal.reason;
        if (response.status !== 200) throw new Error(`HTTP_${response.status}`);
        if ((await readSmallBody(response)) !== `${LIVENESS_BODY}:${nonce}`) throw new Error('UNEXPECTED_RESPONSE');
      };
      await Promise.race([probe(), cancelled]);
      if (stopped) return;
      successes += 1;
      if (failures) log('info', `Recovered after ${failures} failed attempt(s).`);
      else if (successes === 1 || successes % 12 === 0) log('info', 'Public self-ping verified; next check in 5 minutes.');
      failures = 0;
      retryIndex = 0;
    } catch (error) {
      if (stopped) return;
      failures += 1;
      delay = RETRY_DELAYS_MS[retryIndex] ?? INTERVAL_MS;
      retryIndex = retryIndex < RETRY_DELAYS_MS.length ? retryIndex + 1 : 0;
      // Never log raw URLs, response bodies, headers or arbitrary network errors.
      const code = /^(?:HTTP_\d{3}|REQUEST_TIMEOUT|UNEXPECTED_RESPONSE)$/.test(error?.message) ? error.message : 'NETWORK_ERROR';
      log('warn', `${code}; attempt failed (${failures} consecutive). Next attempt in ${delay / 1000}s.`);
    } finally {
      clearTimeoutFn(deadlineTimer);
      deadlineTimer = undefined;
      requestController.signal.removeEventListener('abort', onAbort);
      requestController.abort(); // Release an unread/oversized/error response body.
      if (controller === requestController) controller = undefined;
      inFlight = false;
      if (!stopped) schedule(delay);
    }
  }

  activeStop = stop;
  log('info', 'Enabled: internal public-URL probe every 5 minutes, 20s deadline, up to 3 short retries. Running hours still count toward Render limits.');
  schedule(INITIAL_DELAY_MS);
  return stop;
}

module.exports = { configuration, startSelfKeepAlive, INITIAL_DELAY_MS, INTERVAL_MS, REQUEST_TIMEOUT_MS, RETRY_DELAYS_MS };
