const Customer = require('../models/Customer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const HttpError = require('../utils/HttpError');
const { computeHoldings } = require('./holdings.service');

async function getCustomerLedgerData(userId) {
  const customers = await Customer.find({
    user_id: userId,
    customer_type: 'REGULAR',
    is_active: true
  }).sort('company_name');

  const ledgerData = [];

  for (const customer of customers) {
    const bills = await Bill.find({ customer_id: customer._id, user_id: userId });
    const payments = await Payment.find({ customer_id: customer._id, user_id: userId });

    // Cross-customer-return-aware holding count (shared with customer & dashboard services).
    const { held: cylindersHeld } = computeHoldings(bills);
    let billAmount = bills.reduce((sum, bill) => sum + bill.total_bill_amount, 0);

    const totalPaid = payments.reduce((sum, p) => sum + p.amount_received - p.discount, 0);
    billAmount -= totalPaid;

    ledgerData.push({
      customer_id: customer._id,
      company_name: customer.company_name,
      contact_person: customer.contact_person,
      phone_primary: customer.phone_primary || '',
      gst_number: customer.gst_number || '',
      security_deposit: customer.security_deposit || 0,
      holding_limit: customer.holding_limit || 0,
      bill_amount: billAmount,
      cylinder_hold: cylindersHeld,
      status: cylindersHeld > customer.holding_limit ? 'OVER LIMIT' : ''
    });
  }

  return ledgerData;
}

async function getLedgerReport(userId) {
  return getCustomerLedgerData(userId);
}

async function getOverLimitReport(userId) {
  const ledgerData = await getCustomerLedgerData(userId);
  const overLimit = ledgerData.filter(c => c.status === 'OVER LIMIT');

  return overLimit.map(c => ({
    customer_id: c.customer_id,
    company_name: c.company_name,
    contact_person: c.contact_person,
    phone_primary: c.phone_primary || '',
    holding_limit: c.holding_limit || 0,
    cylinders_held: c.cylinder_hold || 0
  }));
}

async function getDailyReport(userId, date) {
  if (!date) {
    throw new HttpError(400, 'Date parameter is required');
  }

  const startDate = new Date(date);
  const endDate = new Date(date);
  endDate.setHours(23, 59, 59, 999);

  const bills = await Bill.find({
    user_id: userId,
    bill_date: { $gte: startDate, $lte: endDate }
  })
  .populate('customer_id')
  .sort('-createdAt');

  return bills.map(bill => ({
    ...bill.toObject(),
    company_name: bill.customer_id.company_name,
    phone_primary: bill.customer_id.phone_primary
  }));
}

async function getCylinderStockReport(userId) {
  const bills = await Bill.find({ user_id: userId })
    .populate('line_items.gas_type_id')
    .populate('line_items.cylinder_size_id');

  const stockMap = {};

  bills.forEach(bill => {
    bill.line_items.forEach(item => {
      const key = `${item.gas_type_id._id}-${item.cylinder_size_id._id}`;

      if (!stockMap[key]) {
        stockMap[key] = {
          gas_type_name: item.gas_type_id.gas_type_name,
          size_label: item.cylinder_size_id.size_label,
          total_given: 0,
          total_received: 0,
          currently_out: 0
        };
      }

      if (item.direction === 'GIVEN') {
        stockMap[key].total_given += item.quantity;
        stockMap[key].currently_out += item.quantity;
      } else if (item.direction === 'RECEIVED') {
        stockMap[key].total_received += item.quantity;
        stockMap[key].currently_out -= item.quantity;
      }
    });
  });

  return Object.values(stockMap).sort((a, b) => {
    if (a.gas_type_name !== b.gas_type_name) {
      return a.gas_type_name.localeCompare(b.gas_type_name);
    }
    return a.size_label.localeCompare(b.size_label);
  });
}

async function getOutstandingReport(userId) {
  const customers = await Customer.find({ user_id: userId }).sort('company_name');
  const outstandingData = [];

  for (const customer of customers) {
    const bills = await Bill.find({ customer_id: customer._id, user_id: userId });
    const payments = await Payment.find({ customer_id: customer._id, user_id: userId });

    const totalBilled = bills.reduce((sum, bill) => sum + bill.total_bill_amount, 0);
    const totalPaid = payments.reduce((sum, p) => sum + p.amount_received - p.discount, 0);
    const outstanding = totalBilled - totalPaid;

    if (outstanding > 0) {
      outstandingData.push({
        customer_id: customer._id,
        company_name: customer.company_name,
        contact_person: customer.contact_person || '',
        phone_primary: customer.phone_primary || '',
        customer_type: customer.customer_type,
        total_billed: totalBilled,
        total_paid: totalPaid,
        outstanding_amount: outstanding
      });
    }
  }

  outstandingData.sort((a, b) => b.outstanding_amount - a.outstanding_amount);

  return outstandingData;
}

async function getDepositsReport(userId) {
  const customers = await Customer.find({
    user_id: userId,
    customer_type: 'REGULAR',
    security_deposit: { $gt: 0 }
  }).sort('company_name');

  return customers.map(c => ({
    customer_id: c._id,
    company_name: c.company_name,
    contact_person: c.contact_person || '',
    phone_primary: c.phone_primary || '',
    security_deposit: c.security_deposit || 0
  }));
}

async function getCustomerStatement(userId, customerId, startDateStr, endDateStr) {
  const billQuery = { customer_id: customerId, user_id: userId };
  const paymentQuery = { customer_id: customerId, user_id: userId };

  if (startDateStr && endDateStr) {
    const startDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);
    endDate.setHours(23, 59, 59, 999);

    billQuery.bill_date = { $gte: startDate, $lte: endDate };
    paymentQuery.date = { $gte: startDate, $lte: endDate };
  }

  const bills = await Bill.find(billQuery);
  const payments = await Payment.find(paymentQuery);

  const statement = [];

  bills.forEach(bill => {
    statement.push({
      date: bill.bill_date,
      bill_number: bill.bill_number,
      transaction_type: bill.transaction_type,
      type: 'BILL',
      debit: bill.total_bill_amount,
      credit: 0,
      remarks: bill.remarks
    });
  });

  payments.forEach(payment => {
    statement.push({
      date: payment.date,
      receipt_number: payment.receipt_number,
      payment_mode: payment.payment_mode,
      type: 'PAYMENT',
      debit: 0,
      credit: payment.amount_received - payment.discount,
      remarks: payment.remarks
    });
  });

  statement.sort((a, b) => new Date(b.date) - new Date(a.date));

  return statement;
}

module.exports = {
  getCustomerLedgerData,
  getLedgerReport,
  getOverLimitReport,
  getDailyReport,
  getCylinderStockReport,
  getOutstandingReport,
  getDepositsReport,
  getCustomerStatement
};
