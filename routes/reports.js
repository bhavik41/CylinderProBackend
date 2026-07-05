const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const ctrl = require('../controllers/reports.controller');

router.use(authMiddleware);

router.get('/ledger', ctrl.getLedgerReport);
router.get('/over-limit', ctrl.getOverLimitReport);
router.get('/daily', ctrl.getDailyReport);
router.get('/cylinder-stock', ctrl.getCylinderStockReport);
router.get('/outstanding', ctrl.getOutstandingReport);
router.get('/deposits', ctrl.getDepositsReport);
router.get('/customer-statement/:id', ctrl.getCustomerStatement);

module.exports = router;
