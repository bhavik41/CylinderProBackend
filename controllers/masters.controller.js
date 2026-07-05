const asyncHandler = require('../middleware/asyncHandler');
const mastersService = require('../services/masters.service');

exports.listGasTypes = asyncHandler(async (req, res) => {
  res.json(await mastersService.listGasTypes());
});

exports.createGasType = asyncHandler(async (req, res) => {
  res.json(await mastersService.createGasType(req.body.gas_type_name));
});

exports.listCylinderSizes = asyncHandler(async (req, res) => {
  res.json(await mastersService.listCylinderSizes());
});

exports.createCylinderSize = asyncHandler(async (req, res) => {
  res.json(await mastersService.createCylinderSize(req.body.size_label));
});
