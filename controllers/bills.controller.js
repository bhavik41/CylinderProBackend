const asyncHandler = require('../middleware/asyncHandler');
const billService = require('../services/bill.service');

exports.validateCylinder = asyncHandler(async (req, res) => {
  res.json(await billService.validateCylinder(req.user.id, req.body));
});

exports.listBills = asyncHandler(async (req, res) => {
  res.json(await billService.listBills(req.user.id, req.query));
});

exports.getBill = asyncHandler(async (req, res) => {
  res.json(await billService.getBill(req.user.id, req.params.id));
});

exports.createBill = asyncHandler(async (req, res) => {
  res.json(await billService.createBill(req.user.id, req.body));
});

exports.updateBill = asyncHandler(async (req, res) => {
  res.json(await billService.updateBill(req.user, req.params.id, req.body));
});

exports.getTodayStats = asyncHandler(async (req, res) => {
  res.json(await billService.getTodayStats(req.user.id));
});
