const Customer = require('../models/Customer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const HttpError = require('../utils/HttpError');
const { computeHoldings } = require('./holdings.service');
const { insertInBatches } = require('../utils/bulkInsert');

async function getCustomerStats(customerId) {
  const bills = await Bill.find({ customer_id: customerId });

  const { totalGiven, totalReceived, held, totalBillAmount } = computeHoldings(bills);

  const payments = await Payment.find({ customer_id: customerId });
  const totalPaid = payments.reduce((sum, p) => sum + p.amount_received - p.discount, 0);

  return {
    total_given: totalGiven,
    total_received_qty: totalReceived,
    cylinders_held: held,
    total_billed: totalBillAmount,
    total_received: totalPaid,
    total_discount: payments.reduce((sum, p) => sum + p.discount, 0),
    current_bill_amount: totalBillAmount - totalPaid
  };
}

async function listCustomers(userId, { search, status }) {
  const query = { customer_type: 'REGULAR', user_id: userId };

  if (search) {
    query.$or = [
      { company_name: { $regex: search, $options: 'i' } },
      { phone_primary: { $regex: search, $options: 'i' } },
      { gst_number: { $regex: search, $options: 'i' } }
    ];
  }

  const customers = await Customer.find(query).sort('company_name');

  const customersWithStats = await Promise.all(
    customers.map(async (customer) => {
      const stats = await getCustomerStats(customer._id);
      const customerObj = customer.toObject();
      return {
        ...customerObj,
        ...stats,
        status: stats.cylinders_held > customer.holding_limit ? 'OVER LIMIT' :
                customer.is_active ? 'ACTIVE' : 'INACTIVE'
      };
    })
  );

  let filtered = customersWithStats;
  if (status === 'OVER_LIMIT') {
    filtered = customersWithStats.filter(c => c.status === 'OVER LIMIT');
  } else if (status === 'ZERO_BALANCE') {
    filtered = customersWithStats.filter(c => c.current_bill_amount === 0);
  } else if (status === 'ACTIVE') {
    filtered = customersWithStats.filter(c => c.is_active);
  }

  return filtered;
}

async function getCustomerDetail(userId, customerId) {
  const customer = await Customer.findOne({ _id: customerId, user_id: userId });

  if (!customer) {
    throw new HttpError(404, 'Customer not found');
  }

  const stats = await getCustomerStats(customer._id);

  const bills = await Bill.find({ customer_id: customer._id, user_id: userId })
    .populate('line_items.gas_type_id')
    .populate('line_items.cylinder_size_id');

  const breakdown = {};
  bills.forEach(bill => {
    bill.line_items.forEach(item => {
      const key = `${item.gas_type_id.gas_type_name}-${item.cylinder_size_id.size_label}`;
      if (!breakdown[key]) {
        breakdown[key] = {
          gas_type_name: item.gas_type_id.gas_type_name,
          size_label: item.cylinder_size_id.size_label,
          total_given: 0,
          total_received: 0,
          currently_held: 0
        };
      }
      if (item.direction === 'GIVEN') {
        breakdown[key].total_given += item.quantity;
        if (item.returned_via) breakdown[key].total_received += item.quantity;
      } else if (!item.returned_on_behalf_of) {
        breakdown[key].total_received += item.quantity;
      }
      breakdown[key].currently_held = breakdown[key].total_given - breakdown[key].total_received;
    });
  });

  // Per-cylinder "currently held" list (same connection rules as the held count):
  //   a serial is held if Σ GIVEN(not returned_via) − Σ RECEIVED(own, not on-behalf) > 0.
  // Net per serial handles re-issues (e.g. swap round-trips); latest GIVEN supplies the display info.
  const heldNet = {};   // serial -> net count
  const heldInfo = {};  // serial -> latest GIVEN details
  bills.forEach(bill => {
    bill.line_items.forEach(item => {
      const s = item.serial_number;
      if (item.direction === 'GIVEN' && !item.returned_via) {
        heldNet[s] = (heldNet[s] || 0) + item.quantity;
        const t = new Date(bill.bill_date).getTime();
        if (!heldInfo[s] || t >= heldInfo[s]._t) {
          heldInfo[s] = {
            serial_number: s,
            gas_type_name: item.gas_type_id.gas_type_name,
            size_label: item.cylinder_size_id.size_label,
            date_given: bill.bill_date,
            bill_number: bill.bill_number,
            challan_no: bill.challan_no || '',
            rate: item.rate || 0,
            _t: t
          };
        }
      } else if (item.direction === 'RECEIVED' && !item.returned_on_behalf_of) {
        heldNet[s] = (heldNet[s] || 0) - item.quantity;
      }
    });
  });
  const held_cylinders = Object.keys(heldNet)
    .filter(s => heldNet[s] > 0)
    .map(s => { const { _t, ...rest } = heldInfo[s]; return rest; })
    .sort((a, b) => new Date(b.date_given) - new Date(a.date_given));

  const customerObj = customer.toObject(); // includes personalCylindersAtPlant (quantity-only)
  return {
    ...customerObj,
    ...stats,
    cylinder_breakdown: Object.values(breakdown).filter(b => b.currently_held !== 0 || b.total_given > 0),
    held_cylinders,
    status: stats.cylinders_held > customer.holding_limit ? 'OVER LIMIT' : 'ACTIVE'
  };
}

async function createCustomer(userId, body) {
  const customer = new Customer({ ...body, user_id: userId });
  await customer.save();
  return { customer_id: customer._id, message: 'Customer created successfully' };
}

// ─── One-time bulk import (onboarding) ───
// rows: [{ __row, company_name, customer_type, ... }] — already validated client-side,
// but re-validated here (never trust the client). Inserts new records scoped to userId.
async function importCustomers(userId, rows) {
  if (!Array.isArray(rows) || !rows.length) {
    throw new HttpError(400, 'No rows to import');
  }

  const str = (v) => String(v == null ? '' : v).trim();
  const num = (v) => { const n = Number(str(v)); return isFinite(n) && n >= 0 ? n : 0; };

  const items = [];
  const failed = [];
  rows.forEach((r, i) => {
    const row = r.__row || (i + 2);
    const company_name = str(r.company_name);
    const phone_primary = str(r.phone_primary);
    if (!company_name) { failed.push({ row, reason: 'company_name is required' }); return; }
    if (!phone_primary) { failed.push({ row, reason: 'phone_primary is required' }); return; }
    const ct = str(r.customer_type).toUpperCase().replace(/[\s-]+/g, '_');
    items.push({
      __row: row,
      doc: {
        user_id: userId,
        company_name,
        customer_type: ct === 'ONE_TIME' ? 'ONE_TIME' : 'REGULAR',
        contact_person: str(r.contact_person) || undefined,
        phone_primary,
        phone_alternate: str(r.phone_alternate) || undefined,
        address: str(r.address) || undefined,
        gst_number: str(r.gst_number) || undefined,
        security_deposit: num(r.security_deposit),
        holding_limit: num(r.holding_limit)
      }
    });
  });

  const result = await insertInBatches(Customer, items);
  return {
    created: result.created,
    skipped: result.skipped,           // customers have no unique key → normally empty
    failed: [...failed, ...result.failed]
  };
}

async function updateCustomer(userId, customerId, body) {
  const customer = await Customer.findOneAndUpdate(
    { _id: customerId, user_id: userId },
    body,
    { new: true, runValidators: true }
  );

  if (!customer) {
    throw new HttpError(404, 'Customer not found');
  }

  return { message: 'Customer updated successfully' };
}

async function getGivenTransactions(userId, customerId) {
  const bills = await Bill.find({ customer_id: customerId, user_id: userId })
    .populate('line_items.gas_type_id')
    .populate('line_items.cylinder_size_id')
    .sort('-bill_date');

  const transactions = [];
  bills.forEach(bill => {
    bill.line_items.forEach(item => {
      if (item.direction === 'GIVEN') {
        transactions.push({
          line_item_id: item._id,
          date: bill.bill_date,
          bill_number: bill.bill_number,
          gas_type_name: item.gas_type_id.gas_type_name,
          size_label: item.cylinder_size_id.size_label,
          serial_number: item.serial_number,
          quantity: item.quantity,
          personal_cylinders: item.personalCylindersOut || 0,
          rate: item.rate,
          amount: item.amount,
          returned_via: item.returned_via || null,
          returned_via_name: item.returned_via_name || null,
          returned_date: item.returned_date || null
        });
      }
    });
  });

  return transactions;
}

async function getReceivedTransactions(userId, customerId) {
  const bills = await Bill.find({ customer_id: customerId, user_id: userId })
    .populate('line_items.gas_type_id')
    .populate('line_items.cylinder_size_id')
    .sort('-bill_date');

  const transactions = [];
  bills.forEach(bill => {
    bill.line_items.forEach(item => {
      if (item.direction === 'RECEIVED') {
        transactions.push({
          line_item_id: item._id,
          date: bill.bill_date,
          bill_number: bill.bill_number,
          gas_type_name: item.gas_type_id.gas_type_name,
          size_label: item.cylinder_size_id.size_label,
          serial_number: item.serial_number,
          quantity: item.quantity,
          personal_cylinders: item.personalCylindersIn || 0,
          returned_on_behalf_of: item.returned_on_behalf_of || null,
          returned_on_behalf_of_name: item.returned_on_behalf_of_name || null
        });
      }
    });
  });

  return transactions;
}

// Personal-cylinder history: every transaction line where personal cylinders moved
// (personalCylindersIn > 0 OR personalCylindersOut > 0), newest first. Each row carries a
// running "net at plant" count computed per gas-type + size combination in date order.
async function getPersonalCylinderHistory(userId, customerId) {
  const bills = await Bill.find({ customer_id: customerId, user_id: userId })
    .populate('line_items.gas_type_id')
    .populate('line_items.cylinder_size_id')
    .sort('bill_date createdAt'); // ascending so running totals accumulate correctly

  const rows = [];
  const running = {}; // "gas|size" -> cumulative in − out
  for (const bill of bills) {
    // Merge this bill's lines per gas + size, so a swap that takes AND returns personal
    // cylinders in one bill shows as ONE row and the running net is applied per bill
    // (never dipping negative mid-bill from line ordering).
    const groups = {};
    for (const item of bill.line_items) {
      const pin = item.personalCylindersIn || 0;
      const pout = item.personalCylindersOut || 0;
      if (pin <= 0 && pout <= 0) continue;
      const gas = item.gas_type_id ? item.gas_type_id.gas_type_name : '';
      const size = item.cylinder_size_id ? item.cylinder_size_id.size_label : '';
      const key = gas + '|' + size;
      if (!groups[key]) groups[key] = { gas, size, taken: 0, returned: 0 };
      groups[key].taken += pin;
      groups[key].returned += pout;
    }
    for (const key of Object.keys(groups)) {
      const g = groups[key];
      if (g.taken === 0 && g.returned === 0) continue;
      running[key] = (running[key] || 0) + g.taken - g.returned;
      rows.push({
        bill_id: bill._id,
        date: bill.bill_date,
        bill_number: bill.bill_number,
        challan_no: bill.challan_no || '',
        gas_type_name: g.gas,
        size_label: g.size,
        taken: g.taken,
        returned: g.returned,
        // Corrupt data can push the true running count negative; never display a negative —
        // clamp to 0 and flag the row so the UI can show a "Data inconsistency" badge.
        net_at_plant: Math.max(0, running[key]),
        inconsistent: running[key] < 0
      });
    }
  }

  rows.reverse(); // most recent first
  return rows;
}

async function getCustomerPayments(userId, customerId) {
  const payments = await Payment.find({ customer_id: customerId, user_id: userId })
    .populate('bill_id')
    .sort('-date');

  return payments.map(p => ({
    ...p.toObject(),
    bill_number: p.bill_id ? p.bill_id.bill_number : null
  }));
}

module.exports = {
  getCustomerStats,
  listCustomers,
  getCustomerDetail,
  createCustomer,
  importCustomers,
  updateCustomer,
  getGivenTransactions,
  getReceivedTransactions,
  getPersonalCylinderHistory,
  getCustomerPayments
};
