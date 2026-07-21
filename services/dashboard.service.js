const Customer = require('../models/Customer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const Cylinder = require('../models/Cylinder');
const { computeHoldings } = require('./holdings.service');

async function getStats(uid) {
  const bills = await Bill.find({ user_id: uid });
  const payments = await Payment.find({ user_id: uid });
  const customers = await Customer.find({ user_id: uid, customer_type: 'REGULAR', is_active: true });

  const totalBilled = bills.reduce((sum, bill) => sum + bill.total_bill_amount, 0);
  // Phase 14: Due = Billed − Net(R−D) − Discount, which reduces to Billed − Σ amount_received.
  const totalPaid = payments.reduce((sum, payment) => sum + payment.amount_received, 0);
  const total_outstanding = totalBilled - totalPaid;

  let totalCylindersOut = 0;
  bills.forEach(bill => {
    bill.line_items.forEach(item => {
      if (item.direction === 'GIVEN') {
        totalCylindersOut += item.quantity;
      } else if (item.direction === 'RECEIVED') {
        totalCylindersOut -= item.quantity;
      }
    });
  });

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const today_transactions = await Bill.countDocuments({
    user_id: uid,
    is_draft: { $ne: true },
    bill_date: { $gte: startOfDay, $lte: endOfDay }
  });

  const total_security_deposit = customers.reduce((sum, c) => sum + c.security_deposit, 0);

  return {
    total_outstanding: total_outstanding || 0,
    total_customers: customers.length,
    total_cylinders_out: totalCylindersOut,
    today_transactions,
    total_security_deposit
  };
}

async function getCylinderStock(uid) {
  // Response keys kept from the old single-status model:
  //   cylindersAtPlant   = IN_STOCK (any site), cylindersInRotation = AT_CUSTOMER.
  // byLocation = IN_STOCK counts per site.
  const [totalCylinders, cylindersAtPlant, cylindersInRotation, perLocation] = await Promise.all([
    Cylinder.countDocuments({ user_id: uid }),
    Cylinder.countDocuments({ user_id: uid, stock_state: 'IN_STOCK' }),
    Cylinder.countDocuments({ user_id: uid, stock_state: 'AT_CUSTOMER' }),
    Cylinder.aggregate([
      { $match: { user_id: new (require('mongoose').Types.ObjectId)(uid), stock_state: 'IN_STOCK' } },
      { $group: { _id: '$location', count: { $sum: 1 } } }
    ])
  ]);

  const byLocation = {};
  perLocation.forEach(r => { byLocation[r._id] = r.count; });

  return { totalCylinders, cylindersInRotation, cylindersAtPlant, byLocation };
}

async function getOverLimitCustomers(uid) {
  const customers = await Customer.find({ user_id: uid, customer_type: 'REGULAR', is_active: true });

  const overLimitCustomers = [];

  for (const customer of customers) {
    const bills = await Bill.find({ customer_id: customer._id, user_id: uid });

    // Cross-customer-return-aware holding count (shared with customers & reports services).
    const { held: cylindersHeld } = computeHoldings(bills);

    // Filling vendors have no holding limit (Phase 15) — never flagged over limit.
    if (!customer.is_filling_vendor && cylindersHeld > (customer.holding_limit || 0)) {
      overLimitCustomers.push({
        customer_id: customer._id,
        company_name: customer.company_name,
        phone_primary: customer.phone_primary,
        holding_limit: customer.holding_limit,
        cylinders_held: cylindersHeld
      });
    }
  }

  overLimitCustomers.sort((a, b) =>
    (b.cylinders_held - b.holding_limit) - (a.cylinders_held - a.holding_limit)
  );

  return overLimitCustomers;
}

module.exports = { getStats, getCylinderStock, getOverLimitCustomers };
