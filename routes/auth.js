const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const ctrl = require('../controllers/auth.controller');

router.post('/signup', ctrl.signup);
router.post('/signin', ctrl.signin);
router.post('/refresh', authMiddleware, ctrl.refresh);
router.post('/clear-data', authMiddleware, ctrl.clearData);

module.exports = router;
