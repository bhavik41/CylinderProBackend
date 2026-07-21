const Customer = require('../models/Customer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const HttpError = require('../utils/HttpError');
const { computeHoldings } = require('./holdings.service');
const { insertInBatches } = require('../utils/bulkInsert');

// Snapshot-first name resolution (Phase 9): the gas/size names stored on the line item at
// transaction time win; populated master docs are only a fallback for pre-migration data.
const liGas = (item) => item.gas_type_name || (item.gas_type_id && item.gas_type_id.gas_type_name) || '';
const liSize = (item) => item.size_label || (item.cylinder_size_id && item.cylinder_size_id.size_label) || '';

async function getCustomerStats(customerId) {
  const bills = await Bill.find({ customer_id: customerId });

  const { totalGiven, totalReceived, held, totalBillAmount } = computeHoldings(bills);

  const payments = await Payment.find({ customer_id: customerId });
  // Phase 14 (final): Total Received = Σ NET amount per payment (Amount Received − Discount);
  // Amount Due = Total Billed − Total Received(net) − Total Discount.
  // e.g. Billed 5600, Received 5600, Discount 100 → net 5500, due 5600 − 5500 − 100 = 0.
  const totalNetReceived = payments.reduce((sum, p) => sum + (p.amount_received || 0) - (p.discount || 0), 0);
  const totalDiscount = payments.reduce((sum, p) => sum + (p.discount || 0), 0);

  return {
    total_given: totalGiven,
    total_received_qty: totalReceived,
    cylinders_held: held,
    total_billed: totalBillAmount,
    total_received: totalNetReceived,
    total_discount: totalDiscount,
    current_bill_amount: totalBillAmount - totalNetReceived - totalDiscount
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
        // Filling vendors have NO holding limit (Phase 15) — they can never be over limit.
        status: (!customer.is_filling_vendor && stats.cylinders_held > (customer.holding_limit || 0)) ? 'OVER LIMIT' :
                customer.is_active ? 'ACTIVE' : 'INACTIVE'
      };
    })
  );

  let filtered = customersWithStats;
  if (status === 'OVER_LIMIT') {
    filtered = customersWithStats.filter(c => c.status === 'OVER LIMIT');
  } else if (status === 'FILLING_VENDOR') {
    filtered = customersWithStats.filter(c => c.is_filling_vendor);
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
      const key = `${liGas(item)}-${liSize(item)}`;
      if (!breakdown[key]) {
        breakdown[key] = {
          gas_type_name: liGas(item),
          size_label: liSize(item),
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
            gas_type_name: liGas(item),
            size_label: liSize(item),
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
    status: (!customer.is_filling_vendor && stats.cylinders_held > (customer.holding_limit || 0)) ? 'OVER LIMIT' : 'ACTIVE'
  };
}

// Filling vendors have no holding limit (Phase 15) — never persist a numeric limit for them.
function sanitizeVendorLimit(body) {
  if (body && body.is_filling_vendor) return { ...body, holding_limit: null };
  return body;
}

async function createCustomer(userId, body) {
  const customer = new Customer({ ...sanitizeVendorLimit(body), user_id: userId });
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

  // ── Near-duplicate name detection (Phase 11) — bulk-import only, warn but never block ──
  // Flags rows whose normalized name exactly matches, contains/is contained by, or is within
  // edit-distance 2 of an existing customer's name or an earlier row in the same file.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const editDistance = (a, b) => {
    if (Math.abs(a.length - b.length) > 2) return 3; // early out — we only care up to 2
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1, dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
    }
    return dp[a.length][b.length];
  };
  const isSimilar = (a, b) => {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length >= 6 && b.length >= 6 && (a.includes(b) || b.includes(a))) return true;
    return a.length >= 6 && b.length >= 6 && editDistance(a, b) <= 2;
  };
  const existing = await Customer.find({ user_id: userId }, { company_name: 1 });
  const known = existing.map(c => ({ name: c.company_name, key: norm(c.company_name), where: 'existing customer' }));
  const warnings = [];
  for (const it of items) {
    const key = norm(it.doc.company_name);
    const hit = known.find(k => isSimilar(k.key, key));
    if (hit) warnings.push({ row: it.__row, company_name: it.doc.company_name, similar_to: hit.name, where: hit.where });
    known.push({ name: it.doc.company_name, key, where: `row ${it.__row} in this file` });
  }

  const result = await insertInBatches(Customer, items);
  return {
    created: result.created,
    skipped: result.skipped,           // customers have no unique key → normally empty
    failed: [...failed, ...result.failed],
    duplicate_warnings: warnings       // informational only — rows were still imported
  };
}

async function updateCustomer(userId, customerId, body) {
  const customer = await Customer.findOneAndUpdate(
    { _id: customerId, user_id: userId },
    sanitizeVendorLimit(body),
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
    .sort('-bill_date -createdAt'); // newest-first; same date → latest-created bill on top (Phase 14)

  const transactions = [];
  bills.forEach(bill => {
    bill.line_items.forEach(item => {
      if (item.direction === 'GIVEN') {
        transactions.push({
          line_item_id: item._id,
          date: bill.bill_date,
          bill_number: bill.bill_number,
          gas_type_name: liGas(item),
          size_label: liSize(item),
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
    .sort('-bill_date -createdAt'); // newest-first; same date → latest-created bill on top (Phase 14)

  const transactions = [];
  bills.forEach(bill => {
    bill.line_items.forEach(item => {
      if (item.direction === 'RECEIVED') {
        transactions.push({
          line_item_id: item._id,
          date: bill.bill_date,
          bill_number: bill.bill_number,
          gas_type_name: liGas(item),
          size_label: liSize(item),
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

  // Filling vendors (Phase 16): PC flows the OTHER way — pcOut = sent to the vendor for
  // filling (outstanding up), pcIn = received back filled (outstanding down). A negative
  // running net is the NORMAL state, so the regular-customer "Data inconsistency" flag
  // (which fires on running < 0) must not apply; instead the anomaly is running > 0
  // (received back more than was ever sent).
  const cust = await Customer.findOne({ _id: customerId, user_id: userId });
  const isVendor = !!(cust && cust.is_filling_vendor);

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
      const gas = liGas(item);
      const size = liSize(item);
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
        is_filling_vendor: isVendor,
        // Regular customers: corrupt data can push the true running count negative; never
        // display a negative — clamp to 0 and flag the row ("Data inconsistency" badge).
        // Vendors: net_with_vendor = how many PC are outstanding with the vendor after this
        // bill; the anomaly (flagged) is a POSITIVE running count.
        net_at_plant: Math.max(0, running[key]),
        net_with_vendor: isVendor ? Math.max(0, -running[key]) : undefined,
        inconsistent: isVendor ? running[key] > 0 : running[key] < 0
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
