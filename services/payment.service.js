const Payment = require('../models/Payment');
const Bill = require('../models/Bill');
const HttpError = require('../utils/HttpError');

// receipt_number is globally unique, so the next number must come from the numeric max —
// not the newest-by-createdAt document, whose number can lag behind (e.g. backdated entries).
async function generateReceiptNumber() {
  const receipts = await Payment.find({}, 'receipt_number').lean();
  const max = receipts.reduce((m, r) => {
    const n = parseInt(String(r.receipt_number).split('-')[1], 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return `RCP-${String(max + 1).padStart(4, '0')}`;
}

async function createPayment(userId, body) {
  const {
    customer_id,
    bill_id,
    date,
    amount_received,
    discount,
    payment_mode,
    cheque_number,
    upi_transaction_id,
    remarks
  } = body;

  if (!customer_id || !amount_received || !payment_mode) {
    throw new HttpError(400, 'Customer ID, amount, and payment mode are required');
  }

  if (payment_mode === 'CHEQUE' && !cheque_number) {
    throw new HttpError(400, 'Cheque number is required for cheque payments');
  }

  const receiptNumber = await generateReceiptNumber();

  // Challan is never entered manually on payments (Phase 5) — it is derived from the linked
  // bill when there is one, purely for receipt display.
  let finalChallanNo = '';
  if (bill_id) {
    const linkedBill = await Bill.findOne({ _id: bill_id, user_id: userId });
    if (linkedBill) finalChallanNo = linkedBill.challan_no || '';
  }

  const payment = new Payment({
    user_id: userId,
    receipt_number: receiptNumber,
    customer_id,
    bill_id: bill_id || undefined,
    date,
    amount_received,
    discount: discount || 0,
    payment_mode,
    cheque_number,
    upi_transaction_id,
    challan_no: finalChallanNo,
    remarks
  });

  await payment.save();

  return {
    receipt_id: payment._id,
    receipt_number: receiptNumber,
    message: 'Payment recorded successfully'
  };
}

async function listPayments(userId, customerId) {
  const query = { user_id: userId };
  if (customerId) {
    query.customer_id = customerId;
  }

  const payments = await Payment.find(query)
    .populate('customer_id')
    .populate('bill_id')
    .sort('-date');

  return payments.map(payment => ({
    ...payment.toObject(),
    company_name: payment.customer_id.company_name,
    bill_number: payment.bill_id ? payment.bill_id.bill_number : null
  }));
}

async function updatePayment(userId, paymentId, body) {
  const allowed = ['cheque_number', 'upi_transaction_id', 'remarks', 'payment_mode', 'amount_received', 'discount', 'date'];
  const updates = {};
  allowed.forEach(field => {
    if (body[field] !== undefined) updates[field] = body[field];
  });

  const payment = await Payment.findOneAndUpdate(
    { _id: paymentId, user_id: userId },
    updates,
    { new: true }
  );

  if (!payment) {
    throw new HttpError(404, 'Payment not found');
  }

  return { receipt_id: payment._id, message: 'Payment updated successfully' };
}

module.exports = { generateReceiptNumber, createPayment, listPayments, updatePayment };
