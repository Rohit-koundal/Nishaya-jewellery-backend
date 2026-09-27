const LIVENESS_PATH = '/health/live';
const LIVENESS_BODY = 'nishaya-api-alive';
const UUID_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

// Process liveness only. Keep /health as the database/storage readiness check.
// A fresh nonce proves the self-ping reached the application, not a cached page.
function sendLiveness(req, res) {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  const probe = req.query?.probe;
  if (probe !== undefined && (typeof probe !== 'string' || !UUID_PATTERN.test(probe))) {
    return res.status(400).type('text/plain').send('Invalid probe');
  }
  return res.status(200).type('text/plain').send(probe ? `${LIVENESS_BODY}:${probe}` : LIVENESS_BODY);
}

module.exports = { LIVENESS_PATH, LIVENESS_BODY, sendLiveness };
