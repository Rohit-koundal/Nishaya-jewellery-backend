const router = require('express').Router();
const controller = require('../controllers/storefrontHomeController');

router.get('/', controller.getMobileHome);

module.exports = router;
