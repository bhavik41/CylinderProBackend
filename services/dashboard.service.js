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
  const totalPaid = payments.reduce((sum, payment) => sum + payment.amount_received - payment.discount, 0);
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
  const [totalCylinders, cylindersAtPlant, cylindersInRotation] = await Promise.all([
    Cylinder.countDocuments({ user_id: uid }),
    Cylinder.countDocuments({ user_id: uid, status: 'at-plant' }),
    Cylinder.countDocuments({ user_id: uid, status: 'in-rotation' })
  ]);

  return { totalCylinders, cylindersInRotation, cylindersAtPlant };
}

async function getOverLimitCustomers(uid) {
  const customers = await Customer.find({ user_id: uid, customer_type: 'REGULAR', is_active: true });

  const overLimitCustomers = [];

  for (const customer of customers) {
    const bills = await Bill.find({ customer_id: customer._id, user_id: uid });

    // Cross-customer-return-aware holding count (shared with customers & reports services).
    const { held: cylindersHeld } = computeHoldings(bills);

    if (cylindersHeld > customer.holding_limit) {
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
