const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const HttpError = require('../utils/HttpError');

async function listGasTypes() {
  return GasType.find({ is_active: true }).sort('gas_type_name');
}

async function createGasType(gas_type_name) {
  if (!gas_type_name) {
    throw new HttpError(400, 'Gas type name is required');
  }
  const gasType = new GasType({ gas_type_name });
  await gasType.save();
  return { gas_type_id: gasType._id, message: 'Gas type added successfully' };
}

async function listCylinderSizes() {
  return CylinderSize.find({ is_active: true }).sort('size_label');
}

async function createCylinderSize(size_label) {
  if (!size_label) {
    throw new HttpError(400, 'Size label is required');
  }
  const size = new CylinderSize({ size_label });
  await size.save();
  return { size_id: size._id, message: 'Cylinder size added successfully' };
}

module.exports = { listGasTypes, createGasType, listCylinderSizes, createCylinderSize };
