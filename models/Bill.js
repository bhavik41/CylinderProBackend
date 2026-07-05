const mongoose = require('mongoose');

const billLineItemSchema = new mongoose.Schema({
  direction: {
    type: String,
    enum: ['GIVEN', 'RECEIVED'],
    required: true
  },
  gas_type_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'GasType',
    required: true
  },
  cylinder_size_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CylinderSize',
    required: true
  },
  serial_number: {
    type: String,
    default: ''   // blank for personal-cylinder-only lines (quantity-only, no inventory cylinder)
  },
  quantity: {
    type: Number,
    default: 1
  },
  rate: {
    type: Number,
    default: 0
  },
  amount: {
    type: Number,
    default: 0
  },
  // ─── Personal cylinders (quantity-only; customer's own cylinders, NOT our inventory) ───
  // Recorded per gas-type line. They never touch Cylinder inventory status.
  personalCylindersIn:  { type: Number, default: 0 }, // received from customer (→ we hold more)
  personalCylindersOut: { type: Number, default: 0 }, // given back to customer (→ we hold fewer)
  // ─── Cross-customer return annotations (all optional; absent on normal line items) ───
  // Set on Customer B's RECEIVED line when B returns a cylinder actually held by Customer A.
  // Value = Customer A (the original holder it was returned on behalf of).
  returned_on_behalf_of:      { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
  returned_on_behalf_of_name: { type: String, default: null },
  // Set on Customer A's original GIVEN line once that cylinder is returned via Customer B.
  // returned_via = Customer B who physically returned it; returned_date = when.
  returned_via:      { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
  returned_via_name: { type: String, default: null },
  returned_date:     { type: Date, default: null }
});

const billSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  bill_number: {
    type: String,
    required: true,
    unique: true
  },
  customer_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  bill_date: {
    type: Date,
    required: true
  },
  transaction_type: {
    type: String,
    enum: ['GIVEN', 'RECEIVED', 'SWAP'],
    required: true
  },
  challan_no: {
    type: String,
    default: ''
  },
  total_given_qty: {
    type: Number,
    default: 0
  },
  total_received_qty: {
    type: Number,
    default: 0
  },
  total_bill_amount: {
    type: Number,
    default: 0
  },
  remarks: String,
  line_items: [billLineItemSchema],
  // Audit trail for edits made via the Transaction History popup (item 11).
  // Same-session corrections (edited right after creation) do NOT add entries here.
  edit_history: {
    type: [{
      edited_at: { type: Date, default: Date.now },
      edited_by: { type: String, default: '' },
      changes:   { type: [String], default: [] }
    }],
    default: []
  }
}, {
  timestamps: true
});

// Indexes for common queries (bill_number is already unique-indexed above).
billSchema.index({ user_id: 1, customer_id: 1 });   // per-customer history
billSchema.index({ user_id: 1, bill_date: -1 });     // daily report / date filters
billSchema.index({ user_id: 1, createdAt: -1 });     // recent-first listings

billSchema.virtual('bill_id').get(function() {
  return this._id.toString();
});

billSchema.set('toJSON', { virtuals: true });
billSchema.set('toObject', { virtuals: true });

// Auto-update cylinder status based on transaction direction.
// A line item's serial_number is the cylinder's rotational number:
//   RECEIVED -> cylinder is back at-plant
//   GIVEN    -> cylinder is now in-rotation (with the customer)
// RECEIVED is applied BEFORE GIVEN so that a swap round-trip (same rotational
// number received then given again in one bill) nets out to in-rotation.
// Uses the (doc, next) signature so save() BLOCKS until the cylinder-status update completes,
// keeping status updates ordered when several bills are saved back-to-back.
billSchema.post('save', function(doc, next) {
  (async () => {
    const Cylinder = require('./Cylinder');

    const receivedSerials = doc.line_items
      .filter(item => item.direction === 'RECEIVED')
      .map(item => item.serial_number);
    // Exclude GIVEN lines already marked returned — those cylinders are back at the plant,
    // so re-saving the bill must not flip them to in-rotation again.
    const givenSerials = doc.line_items
      .filter(item => item.direction === 'GIVEN' && !item.returned_via)
      .map(item => item.serial_number);

    if (receivedSerials.length) {
      await Cylinder.updateMany(
        { user_id: doc.user_id, rotational_number: { $in: receivedSerials } },
        { status: 'at-plant' }
      );
    }
    if (givenSerials.length) {
      await Cylinder.updateMany(
        { user_id: doc.user_id, rotational_number: { $in: givenSerials } },
        { status: 'in-rotation' }
      );
    }
  })()
    .then(() => next())
    .catch(err => {
      // Don't fail the bill save if cylinder sync has an issue; just log it and continue.
      console.error('Cylinder status sync failed:', err.message);
      next();
    });
});

module.exports = mongoose.model('Bill', billSchema);
