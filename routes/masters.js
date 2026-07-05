const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/masters.controller');

// NOTE: intentionally no authMiddleware — these are global catalogs, not per-tenant data.
router.get('/gas-types', ctrl.listGasTypes);
router.post('/gas-types', ctrl.createGasType);
router.get('/cylinder-sizes', ctrl.listCylinderSizes);
router.post('/cylinder-sizes', ctrl.createCylinderSize);

module.exports = router;
