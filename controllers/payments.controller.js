const asyncHandler = require('../middleware/asyncHandler');
const paymentService = require('../services/payment.service');

exports.createPayment = asyncHandler(async (req, res) => {
  res.json(await paymentService.createPayment(req.user.id, req.body));
});

exports.listPayments = asyncHandler(async (req, res) => {
  res.json(await paymentService.listPayments(req.user.id, req.query.customer_id));
});

exports.updatePayment = asyncHandler(async (req, res) => {
  res.json(await paymentService.updatePayment(req.user.id, req.params.id, req.body));
});
