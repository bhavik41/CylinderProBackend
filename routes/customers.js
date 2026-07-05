const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const ctrl = require('../controllers/customers.controller');

router.use(authMiddleware);

router.get('/', ctrl.listCustomers);
router.get('/:id', ctrl.getCustomerDetail);
router.post('/', ctrl.createCustomer);
router.post('/import', ctrl.importCustomers);
router.put('/:id', ctrl.updateCustomer);
router.get('/:id/transactions/given', ctrl.getGivenTransactions);
router.get('/:id/transactions/received', ctrl.getReceivedTransactions);
router.get('/:id/personal-cylinder-history', ctrl.getPersonalCylinderHistory);
router.get('/:id/payments', ctrl.getCustomerPayments);

module.exports = router;
