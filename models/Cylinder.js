const mongoose = require('mongoose');

const cylinderSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  rotational_number: {
    type: String,
    required: true,
    trim: true
  },
  // Optional — rotational_number is the primary identifier. May be added later.
  physical_number: {
    type: String,
    trim: true
  },
  gas_type: {
    type: String,
    required: true,
    trim: true
  },
  capacity: {
    type: String,
    required: true,
    trim: true
  },
  status: {
    type: String,
    enum: ['in-rotation', 'at-plant'],
    default: 'at-plant'
  }
}, {
  timestamps: true
});

// Rotational number is unique per user (multi-tenant scoping).
cylinderSchema.index({ user_id: 1, rotational_number: 1 }, { unique: true });
// Physical number is optional: unique per user only when a non-empty value is set
// (partial index ignores cylinders with no physical number).
cylinderSchema.index(
  { user_id: 1, physical_number: 1 },
  { unique: true, partialFilterExpression: { physical_number: { $type: 'string', $gt: '' } } }
);
// Status filtering (At Plant / In Rotation) per tenant.
cylinderSchema.index({ user_id: 1, status: 1 });

cylinderSchema.virtual('cylinder_id').get(function() {
  return this._id.toString();
});

cylinderSchema.set('toJSON', { virtuals: true });
cylinderSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Cylinder', cylinderSchema);
