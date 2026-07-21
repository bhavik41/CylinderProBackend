const Customer = require('../models/Customer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const Cylinder = require('../models/Cylinder');
const LocationProfile = require('../models/LocationProfile');
const HttpError = require('../utils/HttpError');
const { computeHoldings } = require('./holdings.service');
const { LOCATIONS, LOCATION_LABELS } = require('../config/locations');
const { countsByCombo } = require('./fillingLog.service');
const { getPcStock } = require('./pcStock.service');

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

    // Phase 14: Due = Billed − Net(R−D) − Discount = Billed − Σ amount_received.
    const totalPaid = payments.reduce((sum, p) => sum + p.amount_received, 0);
    billAmount -= totalPaid;

    ledgerData.push({
      customer_id: customer._id,
      company_name: customer.company_name,
      contact_person: customer.contact_person,
      phone_primary: customer.phone_primary || '',
      gst_number: customer.gst_number || '',
      security_deposit: customer.security_deposit || 0,
      holding_limit: customer.holding_limit || 0,
      is_filling_vendor: !!customer.is_filling_vendor,
      bill_amount: billAmount,
      cylinder_hold: cylindersHeld,
      // Filling vendors have no holding limit (Phase 15) — never flagged over limit.
      status: (!customer.is_filling_vendor && cylindersHeld > (customer.holding_limit || 0)) ? 'OVER LIMIT' : ''
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

    // Filling vendors never appear in pending-payment reports (Phase 14) — we owe them.
    if (customer.is_filling_vendor) continue;

    const totalBilled = bills.reduce((sum, bill) => sum + bill.total_bill_amount, 0);
    // Phase 14: Outstanding = Billed − Net(R−D) − Discount = Billed − Σ amount_received.
    const totalPaid = payments.reduce((sum, p) => sum + p.amount_received, 0);
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
      // Phase 14: a payment settles its gross amount_received (= net + discount).
      credit: payment.amount_received,
      remarks: payment.remarks
    });
  });

  statement.sort((a, b) => new Date(b.date) - new Date(a.date));

  return statement;
}

// ─── Phase 5: DSR (Daily Sales Report) ───
// One date at a time, auto-populated live from bill data (drafts + internal transfers excluded).
// location omitted / 'ALL' → all sites; otherwise that site's CUSTOMER bills only.
// reporting_person auto-fills from the site's LocationProfile manager.
async function getDSR(uid, { date, location }) {
  const day = date ? new Date(date) : new Date();
  const start = new Date(day); start.setHours(0, 0, 0, 0);
  const end = new Date(day); end.setHours(23, 59, 59, 999);

  const query = {
    user_id: uid,
    is_draft: { $ne: true },
    transaction_category: { $ne: 'INTERNAL_TRANSFER' },
    bill_date: { $gte: start, $lte: end }
  };
  const loc = LOCATIONS.includes(location) ? location : null;
  if (loc) query.location = loc;

  const bills = await Bill.find(query)
    .populate('customer_id')
    .populate('line_items.gas_type_id')
    .populate('line_items.cylinder_size_id')
    .sort('createdAt');

  // One row per bill per gas×size, with PC (personal cylinders) as their own columns.
  const rows = [];
  const totals = { filled_qty: 0, empty_qty: 0, pc_in: 0, pc_out: 0, amount: 0 };
  for (const b of bills) {
    const byCombo = {};
    for (const li of b.line_items) {
      // Snapshot-first (Phase 9): names stored at transaction time win over the master docs.
      const gas = li.gas_type_name || (li.gas_type_id ? li.gas_type_id.gas_type_name : '');
      const size = li.size_label || (li.cylinder_size_id ? li.cylinder_size_id.size_label : '');
      const key = gas + '|' + size;
      if (!byCombo[key]) {
        byCombo[key] = {
          bill_id: String(b._id),
          bill_number: b.bill_number, challan_no: b.challan_no || '',
          location: b.location, customer_name: b.customer_id ? b.customer_id.company_name : '',
          gas_type: gas, size,
          filled_qty: 0, empty_qty: 0, pc_in: 0, pc_out: 0, amount: 0,
          remarks: ''
        };
      }
      const r = byCombo[key];
      if (!r.remarks && li.remarks) r.remarks = li.remarks; // per-row DSR note (Phase 10)
      if (li.direction === 'GIVEN') { r.filled_qty += li.quantity || 0; r.amount += li.amount || 0; }
      if (li.direction === 'RECEIVED') r.empty_qty += li.quantity || 0;
      r.pc_in += li.personalCylindersIn || 0;   // PC taken from customer
      r.pc_out += li.personalCylindersOut || 0; // PC returned (refilled) to customer
    }
    Object.values(byCombo).forEach(r => {
      rows.push(r);
      totals.filled_qty += r.filled_qty; totals.empty_qty += r.empty_qty;
      totals.pc_in += r.pc_in; totals.pc_out += r.pc_out; totals.amount += r.amount;
    });
  }

  let reporting_person = '';
  if (loc) {
    const profile = await LocationProfile.findOne({ user_id: uid, location: loc });
    reporting_person = (profile && profile.manager_name) || '';
  }

  return {
    date: start,
    location: loc || 'ALL',
    location_label: loc ? LOCATION_LABELS[loc] : 'All Locations',
    reporting_person,
    rows,
    totals
  };
}

// ─── Phase 5: Stock Summary (Filled + Empty tables per location per day) ───
// Best-effort model (revisit after use):
//   • Every cylinder movement comes from bills (customer GIVEN/RECEIVED, internal TRANSFER).
//   • A cylinder counts as EMPTY while its most recent event is a customer return (RECEIVED);
//     otherwise FILLED (fresh imports and transfer-dispatched cylinders are assumed filled;
//     Chandisar refills happen implicitly at give-out since no fill event exists in the data).
//   • Opening/Closing are replayed states at the day's boundaries; Add/Issue-Receive are the
//     day's actual movements at that site.
// Gas grouping merges O2/MO2/Medical Oxygen into "Oxygen"; blank capacity defaults to 7 m3.
function stockGasKey(name) {
  const n = String(name || '').trim().toUpperCase();
  if (n === 'O2' || n === 'MO2' || n.includes('OXYGEN')) return 'Oxygen';
  return String(name || '').trim() || 'Unknown';
}
const stockCapKey = (cap) => String(cap || '').trim() || '7 m3';

async function getStockSummary(uid, { date, location }) {
  if (!LOCATIONS.includes(location)) throw new HttpError(400, 'A valid location is required');
  const day = date ? new Date(date) : new Date();
  const start = new Date(day); start.setHours(0, 0, 0, 0);
  const end = new Date(day); end.setHours(23, 59, 59, 999);

  const [cylinders, bills] = await Promise.all([
    Cylinder.find({ user_id: uid }),
    Bill.find({ user_id: uid, is_draft: { $ne: true } }).sort('bill_date createdAt')
  ]);

  // Chronological event list per rotational number.
  const events = {}; // serial -> [{ t, type, loc, from, to }]
  for (const b of bills) {
    for (const li of b.line_items) {
      if (!li.serial_number) continue;
      const list = events[li.serial_number] || (events[li.serial_number] = []);
      if (li.direction === 'TRANSFER') list.push({ t: b.bill_date, type: 'TRANSFER', from: b.from_location, to: b.to_location });
      else list.push({ t: b.bill_date, type: li.direction, loc: b.location });
    }
  }

  // State of one cylinder at time T: undo every event after T starting from its current doc.
  const stateAt = (c, T) => {
    const evts = events[c.rotational_number] || [];
    let loc = c.location;
    let inStock = c.stock_state === 'IN_STOCK';
    for (let i = evts.length - 1; i >= 0; i--) {
      const e = evts[i];
      if (new Date(e.t) <= T) break;
      if (e.type === 'TRANSFER') loc = e.from;
      else if (e.type === 'GIVEN') { inStock = true; if (e.loc) loc = e.loc; }
      else if (e.type === 'RECEIVED') { inStock = false; }
    }
    // Empty while the last event ≤ T is a customer return.
    let last = null;
    for (const e of evts) { if (new Date(e.t) <= T) last = e; else break; }
    const empty = !!last && last.type === 'RECEIVED';
    return { loc, inStock, empty };
  };

  const table = {}; // gas|cap -> { gas, capacity, filled:{opening,add,issue,closing}, empty:{opening,receive,issue,closing} }
  const rowFor = (gas, cap) => {
    const key = gas + '|' + cap;
    if (!table[key]) {
      table[key] = {
        gas_type: gas, capacity: cap,
        filled: { opening: 0, add: 0, issue: 0, closing: 0 },
        empty: { opening: 0, receive: 0, issue: 0, closing: 0 }
      };
    }
    return table[key];
  };

  const openingT = new Date(start.getTime() - 1);
  for (const c of cylinders) {
    const gas = stockGasKey(c.gas_type), cap = stockCapKey(c.capacity);
    const open = stateAt(c, openingT);
    const close = stateAt(c, end);
    if (open.inStock && open.loc === location) rowFor(gas, cap)[open.empty ? 'empty' : 'filled'].opening++;
    if (close.inStock && close.loc === location) rowFor(gas, cap)[close.empty ? 'empty' : 'filled'].closing++;

    // Day movements at this site for this cylinder.
    const evts = events[c.rotational_number] || [];
    for (const e of evts) {
      const t = new Date(e.t);
      if (t < start || t > end) continue;
      const r = rowFor(gas, cap);
      if (e.type === 'GIVEN' && e.loc === location) r.filled.issue++;           // issued (filled) to customer
      else if (e.type === 'RECEIVED' && e.loc === location) r.empty.receive++;  // came back empty
      else if (e.type === 'TRANSFER') {
        // Classify the transferred cylinder by its state just before the transfer.
        const before = stateAt(c, new Date(t.getTime() - 1));
        if (e.to === location) r[before.empty ? 'empty' : 'filled'][before.empty ? 'receive' : 'add']++;
        if (e.from === location) r[before.empty ? 'empty' : 'filled'].issue++;
      }
    }
  }

  // Chandisar's Filled "Add" is "Filled Today" from the daily filling log (Phase 11) —
  // Chandisar never receives filled stock from elsewhere, it fills on-site. Other locations
  // keep transfers-in as their Add figure.
  const isChandisar = location === 'AT_PLANT_CHANDISAR';
  if (isChandisar) {
    const y = start.getFullYear(), m = String(start.getMonth() + 1).padStart(2, '0'), d = String(start.getDate()).padStart(2, '0');
    const fillCounts = await countsByCombo(uid, `${y}-${m}-${d}`);
    Object.values(table).forEach(r => { r.filled.add = 0; });
    for (const [key, n] of Object.entries(fillCounts)) {
      const [g, cap] = key.split('|');
      rowFor(stockGasKey(g), stockCapKey(cap)).filled.add = n;
    }

    // Empty Stock "Issue" (Phase 12) = empties leaving the empty pool that day:
    //   (a) cylinders sent to filling-vendor customers (GIVEN quantities on vendor bills), plus
    //   (b) the day's Filling List entries (filled on-site — same data as "Filled Today" above,
    //       so the two rows stay in sync by construction).
    const vendors = await Customer.find({ user_id: uid, is_filling_vendor: true }, { _id: 1 });
    const vendorIds = new Set(vendors.map(v => String(v._id)));
    Object.values(table).forEach(r => { r.empty.issue = 0; });
    for (const [key, n] of Object.entries(fillCounts)) {
      const [g, cap] = key.split('|');
      rowFor(stockGasKey(g), stockCapKey(cap)).empty.issue += n;
    }
    if (vendorIds.size) {
      for (const b of bills) {
        if (b.transaction_category === 'INTERNAL_TRANSFER') continue;
        if (b.location !== location) continue;
        const t = new Date(b.bill_date);
        if (t < start || t > end) continue;
        if (!b.customer_id || !vendorIds.has(String(b.customer_id))) continue;
        for (const li of b.line_items) {
          if (li.direction !== 'GIVEN' || !(li.quantity > 0)) continue;
          rowFor(stockGasKey(li.gas_type_name), stockCapKey(li.size_label)).empty.issue += li.quantity;
        }
      }
    }
  }

  const rows = Object.values(table).sort((a, b) =>
    a.gas_type === b.gas_type ? a.capacity.localeCompare(b.capacity) : a.gas_type.localeCompare(b.gas_type));

  return {
    date: start,
    location,
    location_label: LOCATION_LABELS[location],
    filled_add_label: isChandisar ? 'Filled Today' : 'Add (Transfers In)',
    empty_issue_label: isChandisar ? 'Issue (Filled Today + Sent to Vendors)' : 'Issue (Transfers Out)',
    rows
  };
}

module.exports = {
  getDSR,
  getStockSummary,
  getCustomerLedgerData,
  getLedgerReport,
  getOverLimitReport,
  getDailyReport,
  getCylinderStockReport,
  getOutstandingReport,
  getDepositsReport,
  getCustomerStatement,
  getPcStock
};
