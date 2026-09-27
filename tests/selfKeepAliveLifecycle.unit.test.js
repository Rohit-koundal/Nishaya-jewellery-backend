const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('server starts self-ping only after listening and stops it before closing HTTP', async () => {
  const events = [], handlers = {};
  let listenCallback;
  const app = { locals: {}, listen(_port, _host, callback) { listenCallback = callback; return { close(done) { events.push('close-http'); done(); } }; } };
  const dependencies = {
    dotenv: { config() {} }, path, './app': app, './config/db': async () => {},
    './services/r2Upload': { isR2Configured: () => true }, './services/cloudinaryUpload': { isCloudinaryConfigured: () => false },
    './config/env': { assertProductionSecrets() {}, getOtpMode: () => 'production', isProduction: () => true },
    './config/localOwnerDemo': { isLocalOwnerDemoEnabled: () => false },
    mongoose: { connection: { readyState: 0 } },
    './queues/reelImport.queue': { closeReelImportQueue: async () => {} }, './services/reelImportProgress.service': {},
    './services/selfKeepAliveService': { startSelfKeepAlive() { events.push('start-self-ping'); return () => events.push('stop-self-ping'); } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), {
    __dirname: path.join(__dirname, '..'), console: { log() {}, warn() {}, error() {} },
    process: { env: { NODE_ENV: 'production' }, once(name, callback) { handlers[name] = callback; }, exit(code) { events.push(`exit-${code}`); } },
    require(name) { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; },
    setTimeout: () => ({ unref() {} }), clearTimeout() {},
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, []);
  listenCallback();
  assert.deepEqual(events, ['start-self-ping']);
  await handlers.SIGTERM();
  assert.deepEqual(events, ['start-self-ping', 'stop-self-ping', 'close-http', 'exit-0']);
  await handlers.SIGINT();
  assert.equal(events.length, 4, 'Shutdown is idempotent');
});
