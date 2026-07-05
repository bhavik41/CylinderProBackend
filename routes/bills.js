const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const ctrl = require('../controllers/bills.controller');

router.use(authMiddleware);

router.post('/validate-cylinder', ctrl.validateCylinder);
router.get('/', ctrl.listBills);
router.get('/:id', ctrl.getBill);
router.post('/', ctrl.createBill);
router.put('/:id', ctrl.updateBill);
router.get('/stats/today', ctrl.getTodayStats);

module.exports = router;
