const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const ctrl = require('../controllers/profile.controller');

router.use(authMiddleware);

router.get('/', ctrl.getAccount);
router.put('/', ctrl.updateAccount);
router.post('/change-password', ctrl.changePassword);
router.get('/business', ctrl.getBusinessProfile);
router.put('/business', ctrl.updateBusinessProfile);
router.post('/logout-all', ctrl.logoutAll);
router.delete('/delete-account', ctrl.deleteAccount);
router.get('/export-data', ctrl.exportData);

module.exports = router;
