const asyncHandler = require('../middleware/asyncHandler');
const customerService = require('../services/customer.service');

exports.listCustomers = asyncHandler(async (req, res) => {
  res.json(await customerService.listCustomers(req.user.id, req.query));
});

exports.getCustomerDetail = asyncHandler(async (req, res) => {
  res.json(await customerService.getCustomerDetail(req.user.id, req.params.id));
});

exports.createCustomer = asyncHandler(async (req, res) => {
  res.json(await customerService.createCustomer(req.user.id, req.body));
});

exports.importCustomers = asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  res.json(await customerService.importCustomers(req.user.id, rows));
});

exports.updateCustomer = asyncHandler(async (req, res) => {
  res.json(await customerService.updateCustomer(req.user.id, req.params.id, req.body));
});

exports.getGivenTransactions = asyncHandler(async (req, res) => {
  res.json(await customerService.getGivenTransactions(req.user.id, req.params.id));
});

exports.getReceivedTransactions = asyncHandler(async (req, res) => {
  res.json(await customerService.getReceivedTransactions(req.user.id, req.params.id));
});

exports.getPersonalCylinderHistory = asyncHandler(async (req, res) => {
  res.json(await customerService.getPersonalCylinderHistory(req.user.id, req.params.id));
});

exports.getCustomerPayments = asyncHandler(async (req, res) => {
  res.json(await customerService.getCustomerPayments(req.user.id, req.params.id));
});
