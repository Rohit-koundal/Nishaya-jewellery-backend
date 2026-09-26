const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const analytics = require('../controllers/analyticsController');
const { optionalProtect } = require('../middleware/authMiddleware');
const { optionalResolveStore } = require('../middleware/storeMiddleware');

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

router.post('/events', limiter, optionalProtect, optionalResolveStore, analytics.track);

module.exports = router;
