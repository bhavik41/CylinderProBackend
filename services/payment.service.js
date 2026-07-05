const Payment = require('../models/Payment');
const Bill = require('../models/Bill');
const HttpError = require('../utils/HttpError');

async function generateReceiptNumber() {
  const lastReceipt = await Payment.findOne().sort('-createdAt');
  const nextId = lastReceipt ? parseInt(lastReceipt.receipt_number.split('-')[1]) + 1 : 1;
  return `RCP-${String(nextId).padStart(4, '0')}`;
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
    challan_no,
    remarks
  } = body;

  if (!customer_id || !amount_received || !payment_mode) {
    throw new HttpError(400, 'Customer ID, amount, and payment mode are required');
  }

  if (payment_mode === 'CHEQUE' && !cheque_number) {
    throw new HttpError(400, 'Cheque number is required for cheque payments');
  }

  const receiptNumber = await generateReceiptNumber();

  // Carry the challan number from the linked bill if not explicitly provided
  let finalChallanNo = challan_no || '';
  if (!finalChallanNo && bill_id) {
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
  const allowed = ['challan_no', 'cheque_number', 'upi_transaction_id', 'remarks', 'payment_mode', 'amount_received', 'discount', 'date'];
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
